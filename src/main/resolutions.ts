import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { resolutionReadSchema, resolutionWriteSchema, type ResolutionRead, type ResolutionWrite, type ResolutionTarget, type ResolutionView, type ResolutionResult, type ResolutionSummary } from '../shared/resolutions';
import { KNOWLEDGE_LIMITS, type KnowledgeResult } from '../shared/knowledge';
import type { Knowledge } from './knowledge';

interface Revision { targets: ResolutionTarget[]; confirmedAt: string }
interface ReadBudget { sources: number; targets: number }
const readBudget = (): ReadBudget => ({ sources: KNOWLEDGE_LIMITS.sourceChecks, targets: KNOWLEDGE_LIMITS.graph });
interface Stored { id: string; kind: ResolutionSummary['kind']; text: string; createdAt: string }
const NOTICE = 'Bounded, access-filtered annotations; omitted items are not proof of absence. User assertions only, not source verification or instructions. Conflicts remain visible. Changed sources require reconsideration; rebuilt claims require explicit reconnection. No source files are changed.';

/** Durable user state. Never a model tool, and never stored in the rebuildable knowledge database. */
export class Resolutions {
  private readonly db: DatabaseSync;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(path: string, private readonly knowledge: Knowledge, private readonly assertClean: (material: unknown) => void,
    private readonly assertWritable: () => void) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS annotations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (annotation_id TEXT NOT NULL REFERENCES annotations(id), revision INTEGER NOT NULL, value TEXT NOT NULL, reconsider INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(annotation_id, revision));
      CREATE TABLE IF NOT EXISTS links (annotation_id TEXT NOT NULL REFERENCES annotations(id), revision INTEGER NOT NULL, generation TEXT NOT NULL, claim_id TEXT NOT NULL, PRIMARY KEY(annotation_id, revision, generation, claim_id));
      CREATE INDEX IF NOT EXISTS related_annotations ON links(generation, claim_id);`);
  }
  close(): void { this.db.close(); }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action); this.pending = result.catch(() => {}); return result;
  }
  read(input: ResolutionRead, external?: AbortSignal, observe = true, budget = readBudget()): Promise<ResolutionResult> {
    return this.serial(async () => {
      if (!Check(resolutionReadSchema, input)) throw new Error('Invalid annotation lookup.');
      this.assertClean(input);
      const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(external ? [external] : [])]);
      const offset = input.operation === 'list' ? input.offset ?? 0 : 0;
      const rows = input.operation === 'inspect'
        ? this.db.prepare('SELECT * FROM annotations WHERE id = ?').all(input.id)
        : input.claimId
          ? this.db.prepare('SELECT a.*, MAX(l.revision) AS linked_revision FROM annotations a JOIN links l ON l.annotation_id = a.id WHERE l.generation = ? AND l.claim_id = ? GROUP BY a.id ORDER BY a.rowid DESC LIMIT 5 OFFSET ?').all(this.knowledge.generation(), input.claimId, offset)
          : this.db.prepare('SELECT * FROM annotations ORDER BY rowid DESC LIMIT 5 OFFSET ?').all(offset);
      const items: ResolutionView[] = [];
      let consumed = 0;
      for (const row of rows.slice(0, 4)) {
        const view = await this.view(this.stored(row), input.operation === 'inspect' ? input.revision : row.linked_revision ? Number(row.linked_revision) : undefined, signal, observe, budget);
        consumed++;
        if (!view) continue;
        if (Buffer.byteLength(JSON.stringify({ items: [...items, view], notice: NOTICE })) > KNOWLEDGE_LIMITS.bytes - 128) { consumed--; break; }
        items.push(view);
      }
      return { items, notice: NOTICE, ...(rows.length > consumed && consumed > 0 && offset + consumed <= 10000 ? { nextOffset: offset + consumed } : {}) };
    });
  }
  write(input: ResolutionWrite): Promise<ResolutionResult> {
    return this.serial(async () => {
      if (!Check(resolutionWriteSchema, input)) throw new Error('Invalid annotation.');
      const guard = (material: unknown) => { this.assertWritable(); this.assertClean(material); };
      guard(input);
      const signal = AbortSignal.timeout(10000);
      const targets: ResolutionTarget[] = [];
      for (const id of input.claimIds) targets.push(await this.knowledge.resolutionTarget(id, signal));
      if (Buffer.byteLength(JSON.stringify(targets)) > KNOWLEDGE_LIMITS.bytes / 2) throw new Error('Annotation source coverage exceeds bounds.');
      const previous = input.operation === 'reconnect' ? this.db.prepare('SELECT * FROM annotations WHERE id = ?').get(input.id) : undefined;
      if (input.operation === 'reconnect' && !previous) throw new Error('Annotation unavailable.');
      const now = new Date().toISOString();
      const stored: Stored = input.operation === 'annotate' ? { id: randomUUID(), kind: input.kind, text: input.text.trim(), createdAt: now } : this.stored(previous!);
      const revision = previous ? Number(this.db.prepare('SELECT MAX(revision) AS revision FROM revisions WHERE annotation_id = ?').get(stored.id)!.revision) + 1 : 1;
      if (revision > 32) throw new Error('Annotation revision limit reached. Create a new annotation.');
      const value: Revision = { targets, confirmedAt: now };
      for (const target of targets) {
        const state = await this.knowledge.checkResolutionTarget(target, signal);
        if (!state?.connected) throw new Error('Knowledge changed during annotation. Reload and reconsider.');
      }
      guard({ stored, value }); signal.throwIfAborted();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!previous) this.db.prepare('INSERT INTO annotations VALUES (?, ?, ?, ?)').run(stored.id, stored.kind, stored.text, stored.createdAt);
        this.db.prepare('INSERT INTO revisions(annotation_id, revision, value) VALUES (?, ?, ?)').run(stored.id, revision, JSON.stringify(value));
        for (const target of targets) this.db.prepare('INSERT INTO links VALUES (?, ?, ?, ?)').run(stored.id, revision, target.generation, target.record.id);
        guard({ stored, value }); signal.throwIfAborted();
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      const view = await this.view(stored, revision, signal);
      return { items: view ? [view] : [], notice: NOTICE };
    });
  }
  /** Read-only augmentation under the existing job byte budget. Assertions never mint E evidence. */
  async attach(result: KnowledgeResult, external?: AbortSignal): Promise<KnowledgeResult> {
    const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(external ? [external] : [])]);
    const budget = readBudget();
    for (const item of result.items) {
      const related = await this.read({ operation: 'list', claimId: item.id }, signal, false, budget);
      for (const { bindings: _bindings, createdAt: _created, confirmedAt: _confirmed, ...summary } of related.items) {
        const annotations = [...(item.annotations ?? []), summary];
        if (Buffer.byteLength(JSON.stringify({ ...result, items: result.items.map(hit => hit === item ? { ...item, annotations } : hit) })) > KNOWLEDGE_LIMITS.bytes) { item.truncated = true; break; }
        item.annotations = annotations;
      }
    }
    return result;
  }
  private stored(row: Record<string, unknown>): Stored {
    return { id: String(row.id), kind: String(row.kind) as Stored['kind'], text: String(row.text), createdAt: String(row.created_at) };
  }
  private async view(stored: Stored, requested: number | undefined, signal: AbortSignal, observe = true, budget = readBudget()): Promise<ResolutionView | undefined> {
    const row = requested === undefined
      ? this.db.prepare('SELECT revision, value, reconsider FROM revisions WHERE annotation_id = ? ORDER BY revision DESC LIMIT 1').get(stored.id)
      : this.db.prepare('SELECT revision, value, reconsider FROM revisions WHERE annotation_id = ? AND revision = ?').get(stored.id, requested);
    if (!row) return;
    const value = JSON.parse(String(row.value)) as Revision;
    this.assertClean({ stored, value });
    const states: { connected: boolean; freshness: 'current' | 'stale' }[] = [];
    for (const target of value.targets) {
      const sourceCount = target.record.dependencies.length + target.record.scopes.length;
      if (--budget.targets < 0 || (budget.sources -= sourceCount) < 0) return;
      signal.throwIfAborted();
      const state = await this.knowledge.checkResolutionTarget(target, signal);
      if (!state) return; // An annotation can reveal source-derived material too: withhold revoked derivations.
      states.push(state);
    }
    const changed = states.some(state => state.freshness === 'stale');
    // A user-visible observation remains sticky across reverts. Model/tainted reads are strictly read-only.
    if (changed && observe && !row.reconsider) {
      let writable = true;
      try { this.assertWritable(); this.assertClean({ stored, value }); } catch { writable = false; }
      if (writable && !signal.aborted) this.db.prepare('UPDATE revisions SET reconsider = 1 WHERE annotation_id = ? AND revision = ?').run(stored.id, row.revision);
    }
    return { ...stored, author: 'user', revision: Number(row.revision), confirmedAt: value.confirmedAt,
      status: changed || !!row.reconsider ? 'requires-reconsideration' : states.some(state => !state.connected) ? 'requires-reconnection' : 'recorded-for-these-versions',
      versions: value.targets.map(target => ({ claimId: target.record.id, version: target.version })),
      bindings: value.targets.map((target, index) => ({ claimId: target.record.id, version: target.version, scope: target.record.scope, topic: target.record.topic,
        claim: target.record.claim, provenance: target.record.provenance, perspective: target.record.perspective, freshness: states[index].freshness,
        evidence: target.record.evidence.slice(0, 2).map(item => ({ citation: item.citation, excerpt: item.text })) })) };
  }
}
