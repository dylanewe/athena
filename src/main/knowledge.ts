import { createHash } from 'node:crypto';
import { relative, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { knowledgeCandidatesSchema, type KnowledgeCandidate, type KnowledgeContext, type KnowledgeOwner, type KnowledgeRecord } from '../shared/knowledge';
import type { Evidence } from '../shared/live';
import type { SourceIdentity, SourceScope } from '../shared/sources';
import type { Inventory } from './inventory';
import type { Sources } from './sources';

interface Publication {
  owner: KnowledgeOwner;
  candidates: unknown;
  evidence: Evidence[];
  inspectedFiles?: SourceIdentity[];
  inspectedScopes?: SourceScope[];
  completed: boolean;
  environmentExposed: boolean;
  signal: AbortSignal;
  /** Rechecked immediately before COMMIT: sealing/secret guards are main-owned. */
  assertPublishable?: () => void;
}
type Stored = Omit<KnowledgeRecord, 'owners' | 'relations'>;
const nameKey = (value: string) => value.normalize('NFC').toLowerCase();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Sole writer of rebuildable knowledge. Model output is data, never SQL or authority. */
export class Knowledge {
  private readonly db: DatabaseSync;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(path: string, private readonly sources: Sources, private readonly inventory: Pick<Inventory, 'snapshot'>,
    private readonly assertClean: (material: unknown) => void) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owners (claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(claim_id, message_id));
      CREATE TABLE IF NOT EXISTS dependencies (claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        scope TEXT NOT NULL, path TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(claim_id, scope, path, identity));
      CREATE INDEX IF NOT EXISTS dependency_source ON dependencies(scope, path);
      CREATE TABLE IF NOT EXISTS scope_dependencies (claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        scope TEXT NOT NULL, path TEXT NOT NULL, operation TEXT NOT NULL, query TEXT NOT NULL, identity TEXT NOT NULL,
        PRIMARY KEY(claim_id, scope, path, operation, query, identity));
      CREATE TABLE IF NOT EXISTS relations (claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, target TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE, PRIMARY KEY(claim_id, kind, target));
      CREATE TABLE IF NOT EXISTS relation_owners (claim_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
        conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
        FOREIGN KEY(claim_id, kind, target) REFERENCES relations(claim_id, kind, target) ON DELETE CASCADE,
        PRIMARY KEY(claim_id, kind, target, message_id));`);
  }
  publish(input: Publication): Promise<string[]> { return this.serial(() => this.publishValidated(input)); }
  async reusable(signal: AbortSignal): Promise<KnowledgeContext[]> {
    const records = await this.inspect(signal);
    return records.filter(record => record.validation !== 'stale').slice(-12).map(({ id, scope, topic, summary, claim, kind, provenance, perspective, validation, validationNote }) => ({ id, scope, topic, summary, claim, kind, provenance, perspective, validation, validationNote }));
  }
  inspect(signal?: AbortSignal): Promise<KnowledgeRecord[]> {
    return this.serial(async () => {
      const records = this.records();
      const stale = new Set<string>();
      for (const record of records) if (!await this.fresh([...record.dependencies, ...record.scopes], signal)) stale.add(record.id);
      // Only explicit dependency edges propagate staleness; never similarity.
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of records) if (!stale.has(record.id) && record.relations.some(edge => edge.kind === 'depends-on' && stale.has(edge.target))) {
          stale.add(record.id); changed = true;
        }
      }
      signal?.throwIfAborted();
      return records.map(record => stale.has(record.id) ? { ...record, validation: 'stale', validationNote: 'An inspected dependency changed, moved without reconnection, or is no longer permitted.' } : record);
    });
  }
  clear(): Promise<void> { return this.serial(async () => { this.db.exec('DELETE FROM claims'); }); }
  close(): void { this.db.close(); }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  private async publishValidated(input: Publication): Promise<string[]> {
    const guard = () => {
      input.signal.throwIfAborted();
      if (!input.completed || input.environmentExposed) throw new Error('Only completed, unexposed investigations can publish knowledge.');
      input.assertPublishable?.();
      this.assertClean({ candidates: input.candidates, evidence: input.evidence, inspectedFiles: input.inspectedFiles, inspectedScopes: input.inspectedScopes });
    };
    guard();
    if (!Check(knowledgeCandidatesSchema, input.candidates)) throw new Error('Malformed knowledge candidates.');
    const candidates: KnowledgeCandidate[] = structuredClone(input.candidates);
    if (!candidates.length) return [];
    if (new Set(candidates.map(item => item.id)).size !== candidates.length) throw new Error('Duplicate candidate identity.');
    const observed = structuredClone(input.evidence);
    if (!observed.length || observed.length > 200 || new Set(observed.map(item => item.id)).size !== observed.length) throw new Error('Invalid inspected evidence ledger.');
    const dependencies = [...new Map([...observed.map(item => {
      const { start: _start, end: _end, ...identity } = item.citation;
      return identity;
    }), ...structuredClone(input.inspectedFiles ?? [])].map(item => [digest(item), item])).values()];
    const scopes = [...new Map(structuredClone(input.inspectedScopes ?? []).map(item => [digest(item), item])).values()];
    if (dependencies.length + scopes.length > 1000) throw new Error('Inspected dependency limit reached.');
    const records = candidates.map(candidate => {
      const evidence = candidate.evidenceIds.map(id => {
        const item = observed.find(item => item.id === id);
        if (!item) throw new Error('Citation was not inspected.');
        return item;
      });
      const scope = this.canonicalScope(candidate.scope, evidence);
      // Exact identity only: no fuzzy equivalence, no overwrite of differently worded claims.
      const material = { scope, topic: candidate.topic.normalize('NFC').trim(), summary: candidate.summary.trim(),
        kind: candidate.kind, claim: candidate.claim.trim(), provenance: candidate.provenance, perspective: candidate.perspective };
      const sourceIdentity = (c: SourceIdentity) => ({ scope: this.scope(c), path: this.sourcePath(c), identity: c.contentIdentity });
      const ordered = <T>(items: T[]) => items.sort((a, b) => digest(a).localeCompare(digest(b)));
      const id = 'K' + digest({ ...material,
        evidence: ordered(evidence.map(({ citation, text }) => ({ ...sourceIdentity(citation), start: citation.start, end: citation.end, text }))),
        dependencies: ordered(dependencies.map(sourceIdentity)),
        scopes: ordered(scopes.map(scope => ({ ...sourceIdentity(scope), operation: scope.operation, query: scope.query }))) });
      const supported = candidate.provenance === 'declared' && candidate.perspective !== 'current' && evidence.some(item => item.text.split(/\r?\n/).some(line => line.trim() === material.claim));
      const record: Stored = { ...material, id, evidence, dependencies, scopes,
        validation: supported ? 'supported' : 'unchecked',
        validationNote: supported ? 'The declaration is present verbatim. This does not certify that the declared behavior is implemented.' : 'Model interpretation; schema and citations verified, semantic truth not independently validated.' };
      return { candidate, record };
    });
    const localIds = new Map(records.map(({ candidate, record }) => [candidate.id, record.id]));
    const existing = this.records();
    const edges = records.flatMap(({ candidate, record }) => candidate.relations.map(edge => {
      const target = localIds.get(edge.target) ?? edge.target;
      if (target === record.id || !records.some(item => item.record.id === target) && !existing.some(item => item.id === target)) throw new Error('Unknown or self-referential claim relationship.');
      return { claim: record.id, kind: edge.kind, target };
    }));
    const referenced = new Set(edges.map(edge => edge.target));
    const collect = (id: string): (SourceIdentity | SourceScope)[] => {
      const record = existing.find(item => item.id === id);
      if (!record) return [];
      return [...record.dependencies, ...record.scopes, ...record.relations.filter(edge => edge.kind === 'depends-on' && !referenced.has(edge.target)).flatMap(edge => { referenced.add(edge.target); return collect(edge.target); })];
    };
    const targetDependencies = [...referenced].flatMap(collect);
    if (!await this.fresh([...observed, ...dependencies, ...scopes, ...targetDependencies], input.signal)) throw new Error('Knowledge sources changed before publication.');
    guard();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { record } of records) {
        this.db.prepare('INSERT OR IGNORE INTO claims VALUES (?, ?)').run(record.id, JSON.stringify(record));
        this.db.prepare('INSERT OR IGNORE INTO owners VALUES (?, ?, ?)').run(record.id, input.owner.conversationId, input.owner.messageId);
        for (const item of dependencies) this.db.prepare('INSERT OR IGNORE INTO dependencies VALUES (?, ?, ?, ?)')
          .run(record.id, this.scope(item), this.sourcePath(item), item.contentIdentity);
        for (const scope of scopes) this.db.prepare('INSERT OR IGNORE INTO scope_dependencies VALUES (?, ?, ?, ?, ?, ?)')
          .run(record.id, this.scope(scope), this.sourcePath(scope), scope.operation, scope.query ?? '', scope.contentIdentity);
        // Repeated exact claims retain ALL inspected dependencies, not just the first run.
        const saved = this.db.prepare('SELECT value FROM claims WHERE id = ?').get(record.id)!;
        const previous = JSON.parse(String(saved.value)) as Stored;
        previous.dependencies = [...new Map([...previous.dependencies, ...dependencies].map(item => [digest(item), item])).values()];
        this.db.prepare('UPDATE claims SET value = ? WHERE id = ?').run(JSON.stringify(previous), record.id);
      }
      for (const edge of edges) {
        this.db.prepare('INSERT OR IGNORE INTO relations VALUES (?, ?, ?)').run(edge.claim, edge.kind, edge.target);
        this.db.prepare('INSERT OR IGNORE INTO relation_owners VALUES (?, ?, ?, ?, ?)').run(edge.claim, edge.kind, edge.target, input.owner.conversationId, input.owner.messageId);
      }
      // Recheck after writes while holding the transaction. No unfinished batch escapes on failure/cancellation.
      if (!await this.fresh([...observed, ...dependencies, ...scopes, ...targetDependencies], input.signal)) throw new Error('Knowledge sources changed during publication.');
      guard();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return records.map(item => item.record.id);
  }
  private records(): KnowledgeRecord[] {
    return this.db.prepare('SELECT id, value FROM claims ORDER BY rowid').all().map(row => {
      const record = JSON.parse(String(row.value)) as Stored;
      const relations = this.db.prepare('SELECT claim_id, kind, target FROM relations WHERE claim_id = ? OR (target = ? AND kind = ?)').all(record.id, record.id, 'conflicts-with')
        .map(edge => ({ kind: String(edge.kind) as KnowledgeRecord['relations'][number]['kind'], target: String(edge.target) === record.id ? String(edge.claim_id) : String(edge.target),
          owners: this.db.prepare('SELECT conversation_id, message_id FROM relation_owners WHERE claim_id = ? AND kind = ? AND target = ? ORDER BY rowid').all(edge.claim_id, edge.kind, edge.target).map(owner => ({ conversationId: String(owner.conversation_id), messageId: String(owner.message_id) })) }));
      const owners = this.db.prepare('SELECT conversation_id, message_id FROM owners WHERE claim_id = ? ORDER BY rowid').all(record.id).map(owner => ({ conversationId: String(owner.conversation_id), messageId: String(owner.message_id) }));
      return { ...record, relations, owners, ...(relations.some(edge => edge.kind === 'conflicts-with') ? { validation: 'conflicting' as const, validationNote: 'Explicit conflicting claims retained side by side. Implementation evidence takes precedence over declarations; intended/historical claims are not current implementation.' } : {}) };
    });
  }
  private sourcePath(c: SourceIdentity): string { return c.repository ? relative(c.repository.path, c.path) : c.path; }
  private scope(c: SourceIdentity): string { return c.repository ? nameKey(c.repository.name) : `folder:${c.folder}`; }
  private canonicalScope(proposed: string, evidence: Evidence[]): string {
    const citation = evidence.find(item => this.scope(item.citation) === nameKey(proposed) || (!item.citation.repository && this.scope(item.citation) === proposed))?.citation;
    if (!citation) throw new Error('Scope must match an observed repository name/alias or designated folder.');
    if (citation.repository) {
      const repo = this.inventory.snapshot().repositories.find(item => nameKey(item.name) === nameKey(citation.repository!.name) && item.path === join(citation.folder, citation.repository!.path) && item.presence === 'present');
      if (!repo) throw new Error('Repository scope requires a registered name or alias.');
      return repo.name;
    }
    return `folder:${citation.folder}`;
  }
  private async fresh(evidence: (Evidence | SourceIdentity | SourceScope)[], signal?: AbortSignal): Promise<boolean> {
    const checked = new Set<string>();
    for (const item of evidence) {
      signal?.throwIfAborted();
      const c = 'citation' in item ? item.citation : item;
      let root = c.folder, path = c.path, repository = c.repository;
      if (c.repository) {
        const snapshot = this.inventory.snapshot();
        const repo = snapshot.repositories.find(repo => nameKey(repo.name) === nameKey(c.repository!.name) && repo.presence === 'present');
        const folder = repo && snapshot.roots.find(folder => repo.path === folder.path || repo.path.startsWith(folder.path + '/'));
        if (!repo || !folder) return false;
        root = folder.path; path = relative(root, join(repo.path, this.sourcePath(c)));
        repository = { name: repo.name, path: relative(root, repo.path) || '.' };
      }
      const start = 'citation' in item ? item.citation.start : 1;
      const end = 'citation' in item ? item.citation.end : 1;
      const operation = 'operation' in item ? item.operation : 'read';
      const query = 'operation' in item ? item.query : undefined;
      const key = JSON.stringify({ root, path, start, end, operation, query, identity: c.contentIdentity });
      if (checked.has(key)) continue;
      checked.add(key);
      try {
        const result = await this.sources.run(operation, { root, path, ...(operation === 'read' ? { start, end } : {}), ...(query ? { query } : {}) }, signal, undefined, operation !== 'read');
        const sameOwner = (actual: SourceIdentity['repository']) => repository ? !!actual && nameKey(actual.name) === nameKey(repository.name) && actual.path === repository.path : actual === null;
        if (result.status !== 'complete') return false;
        if (operation !== 'read') {
          if (!result.inspectedScope || result.inspectedScope.contentIdentity !== c.contentIdentity || !sameOwner(result.inspectedScope.repository)) return false;
        } else if (!result.entries.some(entry => !entry.ephemeral && (!('citation' in item) || entry.text === item.text) && entry.citation?.contentIdentity === c.contentIdentity && sameOwner(entry.citation.repository))) return false;
      } catch { return false; }
    }
    return true;
  }
}
