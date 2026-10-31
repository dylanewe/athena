import { createHash } from 'node:crypto';
import { SourceCheckouts } from './source-checkouts';
import { KnowledgeRetrieval, knowledgeName as nameKey } from './knowledge-retrieval';
import { relative, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { knowledgeCandidatesSchema, type KnowledgeCandidate, type KnowledgeOwner, type KnowledgeRecord, type KnowledgeRequest, type KnowledgeResult } from '../shared/knowledge';
import type { Evidence } from '../shared/live';
import type { SourceCheckout, SourceIdentity, SourceScope } from '../shared/sources';
import type { Inventory } from './inventory';
import type { Sources } from './sources';

interface Publication {
  owner: KnowledgeOwner;
  candidates: unknown;
  evidence: Evidence[];
  inspectedFiles?: SourceIdentity[];
  inspectedScopes?: SourceScope[];
  checkouts?: SourceCheckout[];
  completed: boolean;
  environmentExposed: boolean;
  signal: AbortSignal;
  /** Rechecked immediately before COMMIT: sealing/secret guards are main-owned. */
  assertPublishable?: () => void;
}
type Stored = Omit<KnowledgeRecord, 'owners' | 'relations'> & { derivation?: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Sole writer of rebuildable knowledge. Model output is data, never SQL or authority. */
export class Knowledge {
  private readonly db: DatabaseSync;
  private readonly retrieval: KnowledgeRetrieval;
  private readonly checkouts: SourceCheckouts;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(path: string, private readonly sources: Sources, private readonly inventory: Pick<Inventory, 'snapshot'>,
    private readonly assertClean: (material: unknown) => void) {
    this.checkouts = new SourceCheckouts(sources, inventory);
    this.db = new DatabaseSync(path);
    const checkoutIndexMissing = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'checkout_index_version'").get();
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invalidations (claim_id TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkout_dependencies (claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        scope TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(claim_id, scope, identity));
      CREATE INDEX IF NOT EXISTS checkout_source ON checkout_dependencies(scope, identity);
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
    if (checkoutIndexMissing) {
      // Local, restart-safe index backfill only; legacy records still require revalidation.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of this.db.prepare('SELECT id, value FROM claims').iterate()) {
          const record = JSON.parse(String(row.value)) as Stored;
          for (const snapshot of record.checkouts ?? []) this.indexCheckout(record.id, snapshot);
        }
        this.db.exec('CREATE TABLE checkout_index_version (version INTEGER PRIMARY KEY); INSERT INTO checkout_index_version VALUES (1); COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    this.retrieval = new KnowledgeRetrieval(this.db, id => this.records(id)[0],
      (identity, signal) => this.permitted(identity, signal), (identities, signal) => this.fresh(identities, signal),
      (evidence, signal) => this.currentEvidence(evidence, signal),
      (snapshots, signal) => this.checkouts.fresh(snapshots, signal), (ids, affected) => this.invalidate(ids, affected));
  }
  retrieve(request: KnowledgeRequest, signal?: AbortSignal, options: { persistInvalidations?: boolean; canPersistInvalidations?: () => boolean } = {}): Promise<KnowledgeResult> {
    return this.serial(() => this.retrieval.retrieve(request, signal, () => options.persistInvalidations !== false && (options.canPersistInvalidations?.() ?? true)));
  }
  private indexCheckout(id: string, snapshot: SourceCheckout): void {
    this.db.prepare('INSERT OR IGNORE INTO checkout_dependencies VALUES (?, ?, ?)').run(id, this.scope(snapshot), snapshot.contentIdentity);
  }
  private invalidate(ids: string[], affectedSources: SourceIdentity[] = []): void {
    const note = 'Checkout or source access changed. Needs explicit revalidation; retained evidence is historical.';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) {
        this.db.prepare('INSERT OR IGNORE INTO invalidations VALUES (?, ?)').run(id, note);
        // Invalidate contributions sharing an observed incompatible checkout, without a whole-ledger retrieval scan.
        // An already-stale claim alone supplies no changed scope and cannot invalidate a newly revalidated contribution.
        for (const scope of new Set(affectedSources.map(source => this.scope(source)))) this.db.prepare(`
          INSERT OR IGNORE INTO invalidations SELECT d.claim_id, ? FROM checkout_dependencies d
          JOIN checkout_dependencies changed ON changed.scope = d.scope AND changed.identity = d.identity
          WHERE changed.claim_id = ? AND changed.scope = ?`).run(note, id, scope);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  publish(input: Publication): Promise<string[]> { return this.serial(() => this.publishValidated(input)); }
  /** Launch/pre-investigation local census. Invalidations are sticky, including across reverts/restarts. */
  scan(signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      const records = this.records();
      const checkoutChecks = new Map<string, boolean>();
      for (const record of records) {
        signal?.throwIfAborted();
        if (record.validation === 'stale' || !record.checkouts?.length) { this.invalidate([record.id]); continue; }
        const changed: SourceCheckout[] = [];
        for (const snapshot of record.checkouts) {
          const key = JSON.stringify(snapshot);
          if (!checkoutChecks.has(key)) checkoutChecks.set(key, await this.checkouts.fresh([snapshot], signal));
          if (!checkoutChecks.get(key)) changed.push(snapshot);
        }
        if (changed.length) this.invalidate([record.id], changed);
        else if (!await this.fresh([...record.dependencies, ...record.scopes], signal)) this.invalidate([record.id], [...record.dependencies, ...record.scopes]);
      }
      this.propagateInvalidations(records);
    });
  }
  private propagateInvalidations(records: KnowledgeRecord[]): void {
    const stale = new Set(this.db.prepare('SELECT claim_id FROM invalidations').all().map(row => String(row.claim_id)));
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) if (!stale.has(record.id) && record.relations.some(edge => edge.kind === 'depends-on' && stale.has(edge.target))) {
        this.db.prepare('INSERT OR IGNORE INTO invalidations VALUES (?, ?)').run(record.id, 'An explicit claim dependency needs revalidation.');
        stale.add(record.id); changed = true;
      }
    }
  }
  async inspect(signal?: AbortSignal): Promise<KnowledgeRecord[]> {
    await this.scan(signal);
    return this.serial(async () => { signal?.throwIfAborted(); return this.records(); });
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
    const checkouts = this.checkouts.select([...dependencies, ...scopes], input.checkouts ?? await this.checkouts.capture(input.signal, [...dependencies, ...scopes]));
    if (!this.checkouts.covers([...dependencies, ...scopes], checkouts) || input.checkouts && !await this.checkouts.fresh(checkouts, input.signal)) throw new Error('Checkout changed or scan coverage incomplete before publication.');
    const records = candidates.map(candidate => {
      const evidence = candidate.evidenceIds.map(id => {
        const item = observed.find(item => item.id === id);
        if (!item) throw new Error('Citation was not inspected.');
        return item;
      });
      const scope = this.canonicalScope(candidate.scope, evidence);
      // Exact identity only: no fuzzy equivalence, no overwrite of differently worded claims.
      const material = { scope, topic: candidate.topic.normalize('NFC').trim(), summary: candidate.summary.trim(),
        kind: candidate.kind, claim: candidate.claim.trim(), provenance: candidate.provenance, perspective: candidate.perspective,
        ...(candidate.aliases?.length ? { aliases: [...new Set(candidate.aliases.map(alias => alias.normalize('NFC').trim()))].sort() } : {}) };
      const sourceIdentity = (c: SourceIdentity) => ({ scope: this.scope(c), path: this.sourcePath(c), identity: c.contentIdentity });
      const ordered = <T>(items: T[]) => items.sort((a, b) => digest(a).localeCompare(digest(b)));
      const derivation = digest({ ...material,
        evidence: ordered(evidence.map(({ citation, text }) => ({ ...sourceIdentity(citation), start: citation.start, end: citation.end, text }))),
        dependencies: ordered(dependencies.map(sourceIdentity)),
        scopes: ordered(scopes.map(scope => ({ ...sourceIdentity(scope), operation: scope.operation, query: scope.query }))) });
      let id = 'K' + digest({ derivation, checkouts: checkouts.map(item => ({ scope: this.scope(item), identity: item.contentIdentity })).sort((a, b) => a.scope.localeCompare(b.scope)) });
      // Revalidation creates a new contribution; it cannot revive old shared ownership/edges.
      while (this.db.prepare('SELECT 1 FROM invalidations WHERE claim_id = ?').get(id)) id = 'K' + digest({ id, owner: input.owner });
      const supported = candidate.provenance === 'declared' && candidate.perspective !== 'current' && evidence.some(item => item.text.split(/\r?\n/).some(line => line.trim() === material.claim));
      const record: Stored = { ...material, id, derivation, evidence, dependencies, scopes, checkouts,
        validation: supported ? 'supported' : 'unchecked',
        validationNote: supported ? 'The declaration is present verbatim. This does not certify that the declared behavior is implemented.' : 'Model interpretation; schema and citations verified, semantic truth not independently validated.' };
      return { candidate, record };
    });
    const localIds = new Map(records.map(({ candidate, record }) => [candidate.id, record.id]));
    const existing = this.records();
    const edges = records.flatMap(({ candidate, record }) => {
      const proposed = candidate.relations.map(edge => {
        const target = localIds.get(edge.target) ?? edge.target;
        if (target === record.id || !records.some(item => item.record.id === target) && !existing.some(item => item.id === target)) throw new Error('Unknown or self-referential claim relationship.');
        return { claim: record.id, kind: edge.kind, target };
      });
      // An exact derivation cannot drop a retained dependency by omitting its edge.
      // Only an explicit edge to an exactly matching assertion can select a new source-backed contribution.
      const assertion = (item: Stored) => digest({ scope: item.scope, topic: item.topic, summary: item.summary, claim: item.claim,
        kind: item.kind, provenance: item.provenance, perspective: item.perspective, aliases: item.aliases });
      const find = (id: string) => records.find(item => item.record.id === id)?.record ?? existing.find(item => item.id === id)!;
      const inherited = existing.filter(item => item.derivation === record.derivation).flatMap(item => item.relations.filter(edge => edge.kind === 'depends-on')).map(edge => {
        const replacement = proposed.find(proposed => proposed.kind === 'depends-on' && assertion(find(proposed.target)) === assertion(find(edge.target)));
        return { claim: record.id, kind: edge.kind, target: replacement?.target ?? edge.target };
      });
      return [...new Map([...proposed, ...inherited].map(edge => [digest(edge), edge])).values()];
    });
    // Repetition preserves existing edges: validate that resulting graph too,
    // even when a new model submission omits previously retained dependencies.
    const referenced = new Set([...records.map(({ record }) => record.id), ...edges.map(edge => edge.target)]);
    const collect = (id: string): (SourceIdentity | SourceScope)[] => {
      const record = existing.find(item => item.id === id);
      if (!record) return [];
      return [...record.dependencies, ...record.scopes, ...record.relations.filter(edge => edge.kind === 'depends-on' && !referenced.has(edge.target)).flatMap(edge => { referenced.add(edge.target); return collect(edge.target); })];
    };
    const graphDependencies = [...referenced].flatMap(collect);
    const graphRecords = existing.filter(record => referenced.has(record.id));
    if (graphRecords.some(record => record.validation === 'stale' || !record.checkouts?.length) || !await this.checkouts.fresh(graphRecords.flatMap(record => record.checkouts ?? []), input.signal)) throw new Error('Claim dependency changed and requires revalidation.');
    if (!await this.fresh([...observed, ...dependencies, ...scopes, ...graphDependencies], input.signal)) throw new Error('Knowledge sources changed before publication.');
    guard();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { record } of records) {
        this.db.prepare('INSERT OR IGNORE INTO claims VALUES (?, ?)').run(record.id, JSON.stringify(record));
        this.db.prepare('INSERT OR IGNORE INTO owners VALUES (?, ?, ?)').run(record.id, input.owner.conversationId, input.owner.messageId);
        for (const snapshot of checkouts) this.indexCheckout(record.id, snapshot);
        for (const item of dependencies) this.db.prepare('INSERT OR IGNORE INTO dependencies VALUES (?, ?, ?, ?)')
          .run(record.id, this.scope(item), this.sourcePath(item), item.contentIdentity);
        for (const scope of scopes) this.db.prepare('INSERT OR IGNORE INTO scope_dependencies VALUES (?, ?, ?, ?, ?, ?)')
          .run(record.id, this.scope(scope), this.sourcePath(scope), scope.operation, scope.query ?? '', scope.contentIdentity);
        // Repeated exact claims retain ALL inspected dependencies, not just the first run.
        const saved = this.db.prepare('SELECT value FROM claims WHERE id = ?').get(record.id)!;
        const previous = JSON.parse(String(saved.value)) as Stored;
        previous.dependencies = [...new Map([...previous.dependencies, ...dependencies].map(item => [digest(item), item])).values()];
        this.db.prepare('UPDATE claims SET value = ? WHERE id = ?').run(JSON.stringify(previous), record.id);
        this.retrieval.index(previous);
      }
      for (const edge of edges) {
        this.db.prepare('INSERT OR IGNORE INTO relations VALUES (?, ?, ?)').run(edge.claim, edge.kind, edge.target);
        this.db.prepare('INSERT OR IGNORE INTO relation_owners VALUES (?, ?, ?, ?, ?)').run(edge.claim, edge.kind, edge.target, input.owner.conversationId, input.owner.messageId);
      }
      // Recheck after writes while holding the transaction. No unfinished batch escapes on failure/cancellation.
      if (!await this.fresh([...observed, ...dependencies, ...scopes, ...graphDependencies], input.signal)) throw new Error('Knowledge sources changed during publication.');
      if (!await this.checkouts.fresh([...checkouts, ...graphRecords.flatMap(record => record.checkouts ?? [])], input.signal)) throw new Error('Checkout changed during publication.');
      guard();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return records.map(item => item.record.id);
  }
  private records(id?: string): (KnowledgeRecord & { derivation?: string })[] {
    return this.db.prepare(`SELECT id, value FROM claims ${id ? 'WHERE id = ?' : ''} ORDER BY rowid`).all(...(id ? [id] : [])).map(row => {
      const record = JSON.parse(String(row.value)) as Stored;
      const relations = this.db.prepare('SELECT claim_id, kind, target FROM relations WHERE claim_id = ? OR (target = ? AND kind = ?)').all(record.id, record.id, 'conflicts-with')
        .map(edge => ({ kind: String(edge.kind) as KnowledgeRecord['relations'][number]['kind'], target: String(edge.target) === record.id ? String(edge.claim_id) : String(edge.target),
          owners: this.db.prepare('SELECT conversation_id, message_id FROM relation_owners WHERE claim_id = ? AND kind = ? AND target = ? ORDER BY rowid').all(edge.claim_id, edge.kind, edge.target).map(owner => ({ conversationId: String(owner.conversation_id), messageId: String(owner.message_id) })) }));
      const owners = this.db.prepare('SELECT conversation_id, message_id FROM owners WHERE claim_id = ? ORDER BY rowid').all(record.id).map(owner => ({ conversationId: String(owner.conversation_id), messageId: String(owner.message_id) }));
      const invalidation = this.db.prepare('SELECT reason FROM invalidations WHERE claim_id = ?').get(record.id);
      return { ...record, relations, owners, ...(invalidation ? { validation: 'stale' as const, validationNote: String(invalidation.reason) } : relations.some(edge => edge.kind === 'conflicts-with') ? { validation: 'conflicting' as const, validationNote: 'Explicit conflicting claims retained side by side. Implementation evidence takes precedence over declarations; intended/historical claims are not current implementation.' } : {}) };
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
  private resolve(c: SourceIdentity): { root: string; path: string; repository: SourceIdentity['repository'] } | undefined {
    if (!c.repository) return { root: c.folder, path: c.path, repository: null };
    const snapshot = this.inventory.snapshot();
    const repo = snapshot.repositories.find(repo => nameKey(repo.name) === nameKey(c.repository!.name) && repo.presence === 'present');
    const folder = repo && snapshot.roots.find(folder => repo.path === folder.path || repo.path.startsWith(folder.path + '/'));
    if (!repo || !folder) return;
    return { root: folder.path, path: relative(folder.path, join(repo.path, this.sourcePath(c))), repository: { name: repo.name, path: relative(folder.path, repo.path) || '.' } };
  }
  private async currentEvidence(item: Evidence, signal: AbortSignal): Promise<Evidence | undefined> {
    const location = this.resolve(item.citation);
    if (!location) return;
    try {
      const result = await this.sources.run('read', { root: location.root, path: location.path, start: item.citation.start, end: item.citation.end }, signal);
      const entry = result.entries.find(entry => !entry.ephemeral && entry.text === item.text && entry.citation?.contentIdentity === item.citation.contentIdentity);
      if (result.status === 'complete' && entry?.citation) return { id: item.id, citation: entry.citation, text: item.text };
    } catch { /* Unavailable evidence is not runtime support. */ }
  }
  private async permitted(c: SourceIdentity, signal: AbortSignal): Promise<boolean> {
    const resolved = this.resolve(c);
    if (!resolved) return false;
    try {
      const result = await this.sources.run('read', { root: resolved.root, path: resolved.path, start: 1, end: 1 }, signal);
      return result.status === 'complete' && result.entries.some(entry => !entry.ephemeral && (entry.kind === 'directory' || entry.citation &&
        (resolved.repository ? entry.citation.repository?.name === resolved.repository.name && entry.citation.repository.path === resolved.repository.path : entry.citation.repository === null)));
    } catch { return false; }
  }
  private async fresh(evidence: (Evidence | SourceIdentity | SourceScope)[], signal?: AbortSignal): Promise<boolean> {
    const checked = new Set<string>();
    for (const item of evidence) {
      signal?.throwIfAborted();
      const c = 'citation' in item ? item.citation : item;
      const resolved = this.resolve(c);
      if (!resolved) return false;
      const { root, path, repository } = resolved;
      const start = 'citation' in item ? item.citation.start : 1;
      const end = 'citation' in item ? item.citation.end : 1;
      const operation = 'operation' in item ? item.operation : 'read';
      const query = 'operation' in item ? item.query : undefined;
      const key = JSON.stringify({ root, path, start, end, operation, query, identity: c.contentIdentity,
        repository: repository ? { name: nameKey(repository.name), path: repository.path } : null,
        ...('citation' in item ? { excerpt: item.text } : {}) });
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
