import { relative } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Check } from 'typebox/value';
import { flowReferences, isConnection, KNOWLEDGE_LIMITS as L, knowledgeRequestSchema, type KnowledgeRequest, type KnowledgeRecord, type KnowledgeContext, type KnowledgeHit, type KnowledgeResult } from '../shared/knowledge';
import type { SourceCheckout, SourceIdentity, SourceScope } from '../shared/sources';
import type { Evidence } from '../shared/live';

export const knowledgeName = (value: string) => value.normalize('NFC').toLowerCase();
const NOTICE = 'Bounded, access-filtered indexed leads, not exhaustive knowledge or verified semantic truth. No match is not proof of absence. If insufficient, delegate investigate for bounded fresh source exploration. Static analysis is not runtime tracing; implementation evidence takes precedence over declarations.';

function claimContext(record: KnowledgeRecord, stale: boolean): KnowledgeContext {
  return { id: record.id, scope: record.scope, topic: record.topic, summary: record.summary, claim: record.claim, kind: record.kind,
    provenance: record.provenance, perspective: record.perspective, validation: stale ? 'stale' : record.validation,
    ...(record.architecture ? { architecture: record.architecture } : {}), ...(record.flow ? { flow: record.flow } : {}),
    validationNote: stale ? 'An inspected dependency changed or bounded freshness could not be established. Use only as an investigation lead.' : record.validationNote };
}

interface RetrievalBudget {
  records: Map<string, KnowledgeRecord | undefined>;
  sources: Set<string>;
  checkouts: Map<string, boolean>;
  canPersistInvalidations: () => boolean;
  signal: AbortSignal;
  coverage: { required: boolean; derivation: NonNullable<KnowledgeResult['derivation']> };
}

/** Local, rebuildable FTS index and bounded one-hop retrieval. Never model-generated SQL. */
export class KnowledgeRetrieval {
  /** Main-private response capabilities: never serialized into renderer/model results or persistence. */
  private readonly contexts = new WeakMap<object, RetrievalBudget>();
  private budget(signal: AbortSignal, canPersistInvalidations = () => false): RetrievalBudget {
    return { records: new Map(), sources: new Set(), checkouts: new Map(), canPersistInvalidations, signal, coverage: { required: false, derivation: { files: [], scopes: [], checkouts: [] } } };
  }
  inspectionContext(signal: AbortSignal): object {
    const context = {};
    this.contexts.set(context, this.budget(signal));
    return context;
  }
  constructor(private readonly db: DatabaseSync,
    private readonly load: (id: string) => KnowledgeRecord | undefined,
    private readonly permitted: (identity: SourceIdentity, signal: AbortSignal) => Promise<boolean>,
    private readonly fresh: (identities: (SourceIdentity | SourceScope)[], signal: AbortSignal) => Promise<boolean>,
    private readonly currentEvidence: (evidence: Evidence, signal: AbortSignal) => Promise<Evidence | undefined>,
    private readonly checkoutFresh: (snapshots: SourceCheckout[], signal: AbortSignal) => Promise<boolean>,
    private readonly invalidate: (ids: string[], affectedSources: SourceIdentity[]) => void,
    private readonly eligible: (source: SourceIdentity) => boolean) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED, topic, aliases, summary, claim, evidence, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS knowledge_names (scope TEXT NOT NULL, name TEXT NOT NULL, id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE, PRIMARY KEY(scope, name, id));
      CREATE TRIGGER IF NOT EXISTS knowledge_delete AFTER DELETE ON claims BEGIN DELETE FROM knowledge_fts WHERE id = OLD.id; END;
      CREATE TABLE IF NOT EXISTS architecture_entities (id TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE, scope TEXT NOT NULL, type TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS architecture_connections (id TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE, source TEXT NOT NULL REFERENCES claims(id), target TEXT NOT NULL REFERENCES claims(id), type TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS architecture_outgoing ON architecture_connections(source, type);
      CREATE INDEX IF NOT EXISTS architecture_incoming ON architecture_connections(target, type);
      CREATE TABLE IF NOT EXISTS operation_flows (id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE, service TEXT NOT NULL REFERENCES claims(id), PRIMARY KEY(id, service));
      CREATE INDEX IF NOT EXISTS operation_flow_services ON operation_flows(service);
      CREATE TABLE IF NOT EXISTS knowledge_index_version (version INTEGER PRIMARY KEY);`);
    db.exec("INSERT INTO knowledge_fts(knowledge_fts, rank) VALUES ('secure-delete', 1)");
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
  index(record: Pick<KnowledgeRecord, 'id' | 'scope' | 'topic' | 'aliases' | 'summary' | 'claim' | 'evidence' | 'architecture' | 'flow'>): void {
    this.db.prepare('DELETE FROM operation_flows WHERE id = ?').run(record.id);
    for (const service of new Set(record.flow?.steps.map(step => step.service) ?? [])) this.db.prepare('INSERT INTO operation_flows VALUES (?, ?)').run(record.id, service);
    this.db.prepare('DELETE FROM architecture_entities WHERE id = ?').run(record.id);
    this.db.prepare('DELETE FROM architecture_connections WHERE id = ?').run(record.id);
    if (record.architecture) {
      const a = record.architecture;
      if (isConnection(a)) this.db.prepare('INSERT INTO architecture_connections VALUES (?, ?, ?, ?)').run(record.id, a.from, a.to, a.type);
      else this.db.prepare('INSERT INTO architecture_entities VALUES (?, ?, ?)').run(record.id, knowledgeName(record.scope), a.type);
    }
    this.db.prepare('DELETE FROM knowledge_fts WHERE id = ?').run(record.id);
    this.db.prepare('DELETE FROM knowledge_names WHERE id = ?').run(record.id);
    this.db.prepare('INSERT INTO knowledge_fts VALUES (?, ?, ?, ?, ?, ?)').run(record.id, record.topic, (record.aliases ?? []).join(' '), record.summary, record.claim, record.evidence.map(item => item.text).join('\n'));
    for (const name of new Set([record.topic, ...(record.aliases ?? [])].map(knowledgeName))) {
      this.db.prepare('INSERT INTO knowledge_names VALUES (?, ?, ?)').run(knowledgeName(record.scope), name, record.id);
    }
  }
  async retrieve(input: KnowledgeRequest, external?: AbortSignal, canPersistInvalidations = () => true): Promise<KnowledgeResult> {
    if (!Check(knowledgeRequestSchema, input)) throw new Error('Invalid bounded knowledge request.');
    if (input.operation === 'neighborhood' && input.id && (input.scope || input.messageId)) throw new Error('Choose a claim origin or scoped investigation seeds, not both.');
    if (input.operation === 'search' && input.exact && !input.scope) throw new Error('Exact name lookup requires a repository scope.');
    const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(external ? [external] : [])]);
    const offset = 'offset' in input ? input.offset ?? 0 : 0;
    const limit = input.operation === 'search' || input.operation === 'expand' || input.operation === 'neighborhood' || input.operation === 'flows' ? input.limit ?? L.defaultResults : 1;
    const budget = this.budget(signal, canPersistInvalidations);
    budget.coverage.required = input.operation === 'neighborhood' || input.operation === 'flow' || input.operation === 'flows';
    let ids: string[];
    let edges: NonNullable<KnowledgeResult['edges']> = [];
    if (input.operation === 'flow') {
      const origin = await this.checked(input.id, signal, budget);
      ids = origin?.record.flow ? [input.id, ...flowReferences(origin.record.flow)] : [];
    } else if (input.operation === 'flows') {
      const filters: string[] = [], params: SQLInputValue[] = [];
      if (input.messageId) { filters.push('EXISTS (SELECT 1 FROM owners o WHERE o.claim_id = f.id AND o.message_id = ?)'); params.push(input.messageId); }
      if (input.serviceId) { filters.push('f.service = ?'); params.push(input.serviceId); }
      ids = this.db.prepare(`SELECT DISTINCT f.id FROM operation_flows f JOIN claims c ON c.id = f.id ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY c.rowid DESC LIMIT ? OFFSET ?`).all(...params, limit + 1, offset).map(row => String(row.id));
    } else if (input.operation === 'neighborhood') {
      ids = await this.neighborhood(input, limit, signal, budget);
    } else if (input.operation === 'search') {
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
    let derivation: KnowledgeResult['derivation'];
    let consumed = 0;
    for (const id of ids.slice(0, input.operation === 'flow' ? L.results : limit)) {
      external?.throwIfAborted();
      const checked = await this.checked(id, signal, budget);
      consumed++;
      if (!checked) continue;
      const { record, stale } = checked;
      const hit: KnowledgeHit = { ...claimContext(record, stale), aliases: record.aliases ?? [],
        freshness: stale ? 'stale' : 'current', evidence: record.evidence.map((item, index) => ({ index, citation: item.citation })),
        owners: record.owners.slice(0, 8), relations: record.relations.slice(0, 8).map(({ kind, target }) => ({ kind, target })),
        conflicts: [], truncated: record.owners.length > 8 || record.relations.length > 8 };
      const conflicts = [...new Map(record.relations.filter(edge => edge.kind === 'conflicts-with').map(edge => [edge.target, edge])).values()];
      const excerpts = (record: KnowledgeRecord) => record.evidence.map((item, index) => ({ index, citation: item.citation, ...(index < 2 ? { excerpt: item.text.slice(0, L.excerpt), truncated: item.text.length > L.excerpt } : {}) }));
      if (conflicts.length || input.operation === 'detail') hit.evidence = excerpts(record);
      for (const edge of conflicts.slice(0, 3)) {
        const other = await this.checked(edge.target, signal, budget);
        if (!other) { hit.truncated = true; continue; }
        const r = other.record;
        hit.conflicts.push({ ...claimContext(r, other.stale), freshness: other.stale ? 'stale' : 'current', evidence: excerpts(r) });
        hit.truncated ||= r.evidence.length > 2;
      }
      hit.truncated ||= conflicts.length > 3 || (conflicts.length > 0 || input.operation === 'detail') && record.evidence.length > 2;
      if (input.operation === 'detail') {
        hit.detail = { dependencies: record.dependencies.slice(0, 8), scopes: record.scopes.slice(0, 8), dependencyCount: record.dependencies.length, scopeCount: record.scopes.length };
        hit.relations = record.relations.slice(0, 8).map(({ kind, target, owners }) => ({ kind, target, owners: owners.slice(0, 8) }));
        hit.truncated ||= record.dependencies.length > 8 || record.scopes.length > 8 || record.relations.some(edge => edge.owners.length > 8);
      }
      if (input.operation === 'evidence') {
        const item = record.evidence[input.index];
        if (!item) continue;
        hit.evidence = [{ index: input.index, citation: item.citation, excerpt: item.text.slice(0, L.excerpt), truncated: item.text.length > L.excerpt }];
        if (!stale) {
          evidence = await this.currentEvidence(item, signal);
          if (evidence) derivation = checked.derivation;
        }
      }
      const visibleEdges = edges.filter(edge => [...items, hit].some(item => item.id === edge.target));
      if (Buffer.byteLength(JSON.stringify({ items: [...items, hit], edges: visibleEdges, notice: NOTICE })) > L.bytes - 128) { consumed--; break; }
      items.push(hit);
    }
    const next = offset + consumed;
    const result: KnowledgeResult = { items, ...(ids.length > consumed && next <= L.offset && consumed > 0 ? { nextOffset: next } : {}), notice: NOTICE };
    if (input.operation === 'flow' && items.length !== ids.length) {
      result.items = []; delete result.nextOffset;
      result.notice = NOTICE + ' Flow withheld: complete ordered support is unavailable under current access or response bounds.';
    }
    if (edges.length) result.edges = edges.filter(edge => items.some(item => item.id === edge.target));
    if (evidence && derivation?.checkouts.length && Buffer.byteLength(JSON.stringify({ ...result, evidence, derivation })) <= L.bytes) {
      result.evidence = evidence; result.derivation = derivation;
    }
    this.contexts.set(result, budget);
    return this.completeResult(result);
  }
  /** Finalize again after annotation attachment under the same opaque read context. */
  completeResult(result: KnowledgeResult): KnowledgeResult {
    const budget = this.contexts.get(result);
    if (budget && [...budget.records.values()].some(record => record && ![...record.dependencies, ...record.scopes, ...(record.checkouts ?? [])].every(source => this.eligible(source)))) {
      result.items = []; delete result.edges; delete result.evidence; delete result.evidenceId; delete result.derivation;
      result.notice = NOTICE + ' Source access revoked during retrieval.';
      return result;
    }
    if (!budget?.coverage.required) return result;
    result.derivation = budget.coverage.derivation;
    if (Buffer.byteLength(JSON.stringify(result)) > L.bytes) {
      result.items = []; delete result.edges; delete result.derivation; delete result.evidence; delete result.evidenceId;
      result.notice = NOTICE + ' Typed knowledge withheld because complete attachment provenance exceeds response bounds.';
    }
    return result;
  }
  /** Bounded static adjacency, indexed only by the central claim publisher. No inference or independent source authority. */
  private async neighborhood(input: Extract<KnowledgeRequest, { operation: 'neighborhood' }>, limit: number, signal: AbortSignal, budget: RetrievalBudget): Promise<string[]> {
    const filters: string[] = [], params: SQLInputValue[] = [];
    if (input.scope) { filters.push('e.scope = ?'); params.push(knowledgeName(input.scope)); }
    if (input.messageId) { filters.push('EXISTS (SELECT 1 FROM owners o WHERE o.claim_id = e.id AND o.message_id = ?)'); params.push(input.messageId); }
    const seeds = input.id ? [input.id] : this.db.prepare(`SELECT e.id FROM architecture_entities e JOIN claims c ON c.id = e.id ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY c.rowid DESC LIMIT ?`).all(...params, limit).map(row => String(row.id));
    const ids = new Set<string>();
    const queue: { id: string; depth: number }[] = [];
    const add = async (id: string, depth: number) => {
      if (ids.has(id)) return true;
      if (ids.size >= limit || signal.aborted) return false;
      const item = await this.checked(id, signal, budget);
      if (!item?.record.architecture) return false;
      ids.add(id);
      if (!isConnection(item.record.architecture)) queue.push({ id, depth });
      return true;
    };
    // Reserve room for connection claims and opposite endpoints before filling with extra seeds.
    const seedLimit = input.id || input.depth === 0 ? limit : Math.max(1, Math.floor(limit / 3));
    for (const id of seeds.slice(0, seedLimit)) {
      const origin = await this.checked(id, signal, budget);
      const a = origin?.record.architecture;
      if (a && isConnection(a)) {
        await add(a.from, 0); await add(a.to, 0);
        if (input.depth > 0) await add(id, 0);
      } else if (a) await add(id, 0);
    }
    for (let cursor = 0; cursor < queue.length && ids.size < limit; cursor++) {
      const node = queue[cursor];
      if (node.depth >= input.depth) continue;
      const kinds = input.kinds;
      const rows = this.db.prepare(`SELECT id, source, target FROM architecture_connections WHERE (source = ? OR target = ?) ${kinds ? `AND type IN (${kinds.map(() => '?').join(',')})` : ''} ORDER BY rowid DESC LIMIT ?`).all(node.id, node.id, ...(kinds ?? []), limit);
      for (const row of rows) {
        // Checking the connection includes both endpoints and all transitive provenance in this response's budget.
        if (!await add(String(row.id), node.depth + 1)) continue;
        await add(String(row.source), node.depth + 1); await add(String(row.target), node.depth + 1);
      }
    }
    for (const id of input.id ? [] : seeds) {
      if (ids.size >= limit) break;
      await add(id, 0);
    }
    return [...ids];
  }
  async compareAnnotationSnapshot(record: KnowledgeRecord, external: AbortSignal, connected: boolean, context?: object) {
    const inherited = context ? this.contexts.get(context) : this.budget(external);
    if (!inherited) return; // An unknown/cloned response cannot acquire a replacement budget.
    const budget = { ...inherited, canPersistInvalidations: () => false };
    const signal = AbortSignal.any([external, inherited.signal]);
    const current = connected ? await this.checked(record.id, signal, budget) : undefined;
    if (connected && !current) return;
    const retained = await this.checked(record.id, signal, budget, record);
    return retained ? { current, retained } : undefined;
  }
  async annotationTarget(id: string, signal: AbortSignal) {
    return this.checked(id, signal, this.budget(signal));
  }
  private async checked(id: string, signal: AbortSignal, budget: RetrievalBudget, snapshot?: KnowledgeRecord): Promise<{ record: KnowledgeRecord; stale: boolean; derivation: NonNullable<KnowledgeResult['derivation']> } | undefined> {
    const load = (key: string) => {
      if (!budget.records.has(key)) {
        if (budget.records.size >= L.graph) return;
        budget.records.set(key, this.load(key));
      }
      return budget.records.get(key);
    };
    const current = load(id);
    if (!budget.records.has(id)) return; // The response-wide graph budget is exhausted, even for a retained snapshot.
    const record = snapshot ?? current;
    if (!record) return;
    const invalidate = (ids: string[], affectedSources: SourceIdentity[] = []) => {
      if (!signal.aborted && budget.canPersistInvalidations()) this.invalidate(ids, affectedSources);
    };
    const visited = new Map<string, KnowledgeRecord>();
    const identities: (SourceIdentity | SourceScope)[] = [];
    let complete = true, invalidated = false;
    const checkouts: SourceCheckout[] = [];
    const collect = (item: KnowledgeRecord) => {
      if (visited.has(item.id)) return;
      if (visited.size >= L.graph) { complete = false; return; }
      visited.set(item.id, item);
      budget.coverage.required ||= !!item.architecture || !!item.flow;
      identities.push(...item.dependencies, ...item.scopes);
      invalidated ||= item.validation === 'stale' || !item.checkouts?.length;
      checkouts.push(...(item.checkouts ?? []));
      for (const edge of item.relations.filter(edge => edge.kind === 'depends-on')) {
        const target = load(edge.target);
        if (target) collect(target); else complete = false;
      }
    };
    collect(record);
    const affectedBy = (identity: SourceIdentity) => {
      const key = (source: SourceIdentity) => source.repository
        ? JSON.stringify([knowledgeName(source.repository.name), relative(source.repository.path, source.path)])
        : JSON.stringify([source.folder, source.path]);
      return [...new Set([record.id, ...[...visited.keys()].filter(id => {
        const item = visited.get(id)!;
        return [...item.dependencies, ...item.scopes].some(source => key(source) === key(identity));
      })])];
    };
    const unique = [...new Map(identities.map(item => [JSON.stringify(item), item])).values()];
    // Fail closed rather than exposing material whose current access cannot be checked.
    if (!complete || signal.aborted) return;
    const unchecked = unique.filter(item => !budget.sources.has(JSON.stringify(item)));
    if (budget.sources.size + unchecked.length > L.sourceChecks) return;
    for (const identity of unique) {
      budget.sources.add(JSON.stringify(identity));
      if (!await this.permitted(identity, signal)) { invalidate(affectedBy(identity), [identity]); return; }
    }
    // Legacy scope fingerprints do not retain descendant membership. A mismatch
    // could be revoked access, not merely changed content: conservatively withhold
    // the whole derivation rather than releasing a potentially revoked stale lead.
    for (const identity of unique.filter(item => 'operation' in item)) {
      if (!await this.fresh([identity], signal)) { invalidate(affectedBy(identity), [identity]); return; }
    }
    for (const snapshot of checkouts) {
      const key = JSON.stringify(snapshot);
      if (!budget.checkouts.has(key)) budget.checkouts.set(key, await this.checkoutFresh([snapshot], signal));
      if (!budget.checkouts.get(key)) invalidated = true;
    }
    const filesChanged = !invalidated && !await this.fresh(unique.filter(item => !('operation' in item)), signal);
    const stale = invalidated || filesChanged;
    if (stale) {
      const staleIds = [...visited.keys()].filter(id => {
        const item = visited.get(id)!;
        return item.validation === 'stale' || !item.checkouts?.length || item.checkouts.some(snapshot => budget.checkouts.get(JSON.stringify(snapshot)) === false);
      });
      invalidate([...new Set([record.id, ...staleIds])], [
        ...checkouts.filter(snapshot => budget.checkouts.get(JSON.stringify(snapshot)) === false), ...(filesChanged ? unique : []),
      ]);
    }
    const derivation = {
      files: unique.filter(item => !('operation' in item)), scopes: unique.filter((item): item is SourceScope => 'operation' in item),
      checkouts: [...new Map(checkouts.map(snapshot => [JSON.stringify(snapshot), snapshot])).values()],
    };
    // Accumulate before knowing which returned/attached claim is typed. The shared
    // context enables its complete envelope as soon as any typed derivation is read.
    const merge = <T>(left: T[], right: T[]) => [...new Map([...left, ...right].map(item => [JSON.stringify(item), item])).values()];
    const coverage = budget.coverage.derivation;
    coverage.files = merge(coverage.files, derivation.files);
    coverage.scopes = merge(coverage.scopes, derivation.scopes);
    coverage.checkouts = merge(coverage.checkouts, derivation.checkouts);
    if (!unique.every(source => this.eligible(source)) || !checkouts.every(source => this.eligible(source))) return;
    return { record, stale, derivation };
  }
}
