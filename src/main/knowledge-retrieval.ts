import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Check } from 'typebox/value';
import { KNOWLEDGE_LIMITS as L, knowledgeRequestSchema, type KnowledgeRequest, type KnowledgeRecord, type KnowledgeHit, type KnowledgeResult } from '../shared/knowledge';
import type { SourceIdentity, SourceScope } from '../shared/sources';
import type { Evidence } from '../shared/live';

export const knowledgeName = (value: string) => value.normalize('NFC').toLowerCase();
const NOTICE = 'Bounded, access-filtered indexed leads, not exhaustive knowledge or verified semantic truth. No match is not proof of absence. If insufficient, delegate investigate for bounded fresh source exploration. Static analysis is not runtime tracing; implementation evidence takes precedence over declarations.';

interface RetrievalBudget {
  records: Map<string, KnowledgeRecord | undefined>;
  sources: Set<string>;
}

/** Local, rebuildable FTS index and bounded one-hop retrieval. Never model-generated SQL. */
export class KnowledgeRetrieval {
  constructor(private readonly db: DatabaseSync,
    private readonly load: (id: string) => KnowledgeRecord | undefined,
    private readonly permitted: (identity: SourceIdentity, signal: AbortSignal) => Promise<boolean>,
    private readonly fresh: (identities: (SourceIdentity | SourceScope)[], signal: AbortSignal) => Promise<boolean>,
    private readonly currentEvidence: (evidence: Evidence, signal: AbortSignal) => Promise<Evidence | undefined>) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED, topic, aliases, summary, claim, evidence, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS knowledge_names (scope TEXT NOT NULL, name TEXT NOT NULL, id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE, PRIMARY KEY(scope, name, id));
      CREATE TRIGGER IF NOT EXISTS knowledge_delete AFTER DELETE ON claims BEGIN DELETE FROM knowledge_fts WHERE id = OLD.id; END;
      CREATE TABLE IF NOT EXISTS knowledge_index_version (version INTEGER PRIMARY KEY);`);
    if (!db.prepare('SELECT version FROM knowledge_index_version WHERE version = 1').get()) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM knowledge_fts; DELETE FROM knowledge_names');
        for (const row of db.prepare('SELECT value FROM claims').iterate()) this.index(JSON.parse(String(row.value)) as KnowledgeRecord);
        db.exec('INSERT INTO knowledge_index_version VALUES (1); COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  /** Called inside the publisher's transaction, so failed publication cannot enter search. */
  index(record: Pick<KnowledgeRecord, 'id' | 'scope' | 'topic' | 'aliases' | 'summary' | 'claim' | 'evidence'>): void {
    this.db.prepare('DELETE FROM knowledge_fts WHERE id = ?').run(record.id);
    this.db.prepare('DELETE FROM knowledge_names WHERE id = ?').run(record.id);
    this.db.prepare('INSERT INTO knowledge_fts VALUES (?, ?, ?, ?, ?, ?)').run(record.id, record.topic, (record.aliases ?? []).join(' '), record.summary, record.claim, record.evidence.map(item => item.text).join('\n'));
    for (const name of new Set([record.topic, ...(record.aliases ?? [])].map(knowledgeName))) {
      this.db.prepare('INSERT INTO knowledge_names VALUES (?, ?, ?)').run(knowledgeName(record.scope), name, record.id);
    }
  }
  async retrieve(input: KnowledgeRequest, external?: AbortSignal): Promise<KnowledgeResult> {
    if (!Check(knowledgeRequestSchema, input)) throw new Error('Invalid bounded knowledge request.');
    if (input.operation === 'search' && input.exact && !input.scope) throw new Error('Exact name lookup requires a repository scope.');
    const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(external ? [external] : [])]);
    const offset = 'offset' in input ? input.offset ?? 0 : 0;
    const limit = input.operation === 'search' || input.operation === 'expand' ? input.limit ?? L.defaultResults : 1;
    const budget: RetrievalBudget = { records: new Map(), sources: new Set() };
    let ids: string[];
    let edges: NonNullable<KnowledgeResult['edges']> = [];
    if (input.operation === 'search') {
      const filters: string[] = [], params: SQLInputValue[] = [];
      if (input.scope) { filters.push('EXISTS (SELECT 1 FROM knowledge_names n WHERE n.id = c.id AND n.scope = ?)'); params.push(knowledgeName(input.scope)); }
      if (input.messageId) { filters.push('EXISTS (SELECT 1 FROM owners o WHERE o.claim_id = c.id AND o.message_id = ?)'); params.push(input.messageId); }
      if (input.exact) {
        filters.push('EXISTS (SELECT 1 FROM knowledge_names n WHERE n.id = c.id AND n.name = ?)'); params.push(knowledgeName(input.query.trim()));
      }
      // A query is literal data: tokenize, quote, and cap it; never accept FTS operators.
      const tokens = input.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
      if (input.query.trim() && !tokens.length && !input.exact) return { items: [], notice: NOTICE };
      const fullText = !input.exact && tokens.length > 0;
      if (fullText) { filters.push('knowledge_fts MATCH ?'); params.push(tokens.map(token => `"${token}"`).join(' AND ')); }
      ids = this.db.prepare(`SELECT c.id FROM claims c ${fullText ? 'JOIN knowledge_fts ON knowledge_fts.id = c.id' : ''}
        ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
        ORDER BY ${fullText ? 'bm25(knowledge_fts, 0, 10, 10, 4, 2, 1), ' : ''}c.rowid DESC LIMIT ? OFFSET ?`)
        .all(...params, limit + 1, offset).map(row => String(row.id));
    } else if (input.operation === 'expand') {
      // Only explicit, typed, one-hop edges. Cycles never recurse into model output.
      const origin = await this.checked(input.id, signal, budget);
      if (!origin) return { items: [], notice: NOTICE };
      edges = origin.record.relations.filter(edge => input.kinds.includes(edge.kind)).map(({ kind, target }) => ({ source: input.id, kind, target }));
      ids = [...new Set(edges.map(edge => edge.target))].slice(offset, offset + limit + 1);
    } else ids = [input.id];
    const items: KnowledgeHit[] = [];
    let evidence: Evidence | undefined;
    let consumed = 0;
    for (const id of ids.slice(0, limit)) {
      external?.throwIfAborted();
      const checked = await this.checked(id, signal, budget);
      consumed++;
      if (!checked) continue;
      const { record, stale } = checked;
      const hit: KnowledgeHit = { id: record.id, scope: record.scope, topic: record.topic, aliases: record.aliases ?? [], summary: record.summary,
        claim: record.claim, kind: record.kind, provenance: record.provenance, perspective: record.perspective,
        validation: stale ? 'stale' : record.validation, validationNote: stale ? 'An inspected dependency changed or bounded freshness could not be established. Use only as an investigation lead.' : record.validationNote,
        freshness: stale ? 'stale' : 'current', evidence: record.evidence.map((item, index) => ({ index, citation: item.citation })),
        owners: record.owners.slice(0, 8), relations: record.relations.slice(0, 8).map(({ kind, target }) => ({ kind, target })),
        truncated: record.owners.length > 8 || record.relations.length > 8 };
      if (input.operation === 'detail') {
        hit.detail = { dependencies: record.dependencies.slice(0, 8), scopes: record.scopes.slice(0, 8), dependencyCount: record.dependencies.length, scopeCount: record.scopes.length };
        hit.relations = record.relations.slice(0, 8).map(({ kind, target, owners }) => ({ kind, target, owners: owners.slice(0, 8) }));
        hit.truncated ||= record.dependencies.length > 8 || record.scopes.length > 8 || record.relations.some(edge => edge.owners.length > 8);
      }
      if (input.operation === 'evidence') {
        const item = record.evidence[input.index];
        if (!item) continue;
        hit.evidence = [{ index: input.index, citation: item.citation, excerpt: item.text.slice(0, L.excerpt), truncated: item.text.length > L.excerpt }];
        if (!stale) evidence = await this.currentEvidence(item, signal);
      }
      const visibleEdges = edges.filter(edge => [...items, hit].some(item => item.id === edge.target));
      if (Buffer.byteLength(JSON.stringify({ items: [...items, hit], edges: visibleEdges, notice: NOTICE })) > L.bytes - 128) { consumed--; break; }
      items.push(hit);
    }
    const next = offset + consumed;
    const result: KnowledgeResult = { items, ...(ids.length > consumed && next <= L.offset && consumed > 0 ? { nextOffset: next } : {}), notice: NOTICE };
    if (edges.length) result.edges = edges.filter(edge => items.some(item => item.id === edge.target));
    if (evidence && Buffer.byteLength(JSON.stringify({ ...result, evidence })) <= L.bytes) result.evidence = evidence;
    return result;
  }
  private async checked(id: string, signal: AbortSignal, budget: RetrievalBudget): Promise<{ record: KnowledgeRecord; stale: boolean } | undefined> {
    const load = (key: string) => {
      if (!budget.records.has(key)) {
        if (budget.records.size >= L.graph) return;
        budget.records.set(key, this.load(key));
      }
      return budget.records.get(key);
    };
    const record = load(id);
    if (!record) return;
    const visited = new Set<string>();
    const identities: (SourceIdentity | SourceScope)[] = [];
    let complete = true;
    const collect = (item: KnowledgeRecord) => {
      if (visited.has(item.id)) return;
      if (visited.size >= L.graph) { complete = false; return; }
      visited.add(item.id);
      identities.push(...item.dependencies, ...item.scopes);
      for (const edge of item.relations.filter(edge => edge.kind === 'depends-on')) {
        const target = load(edge.target);
        if (target) collect(target); else complete = false;
      }
    };
    collect(record);
    const unique = [...new Map(identities.map(item => [JSON.stringify(item), item])).values()];
    // Fail closed rather than exposing material whose current access cannot be checked.
    if (!complete || signal.aborted) return;
    const unchecked = unique.filter(item => !budget.sources.has(JSON.stringify(item)));
    if (budget.sources.size + unchecked.length > L.sourceChecks) return;
    for (const identity of unique) {
      budget.sources.add(JSON.stringify(identity));
      if (!await this.permitted(identity, signal)) return;
    }
    // Legacy scope fingerprints do not retain descendant membership. A mismatch
    // could be revoked access, not merely changed content: conservatively withhold
    // the whole derivation rather than releasing a potentially revoked stale lead.
    if (!await this.fresh(unique.filter(item => 'operation' in item), signal)) return;
    const stale = !await this.fresh(unique.filter(item => !('operation' in item)), signal);
    return { record, stale };
  }
}
