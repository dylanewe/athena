import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Conversations } from '../../src/main/conversations';
import type { Evidence, LiveResult } from '../../src/shared/live';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); for (const action of cleanup.splice(0).reverse()) action(); });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const directory = mkdtempSync(join(tmpdir(), 'athena-retention-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'conversations.sqlite');
  const open = () => { const store = new Conversations(path); cleanup.push(() => store.close()); return store; };
  return { store: open(), open, path };
}
const evidence: Evidence[] = [{ id: 'E1', text: 'export const answer = 42;', citation: { folder: '/original', path: 'answer.ts', repository: null, revision: null, contentIdentity: 'sha256:fixture', start: 1, end: 1 } }];
const result: LiveResult = { status: 'complete', text: 'The answer is 42 [E1].', history: [{ role: 'user', content: 'Verbose private protocol', timestamp: 0 }], requests: 1, usageComplete: true,
  exploration: { history: [{ role: 'user', content: 'Verbose child protocol', timestamp: 0 }], result: { status: 'complete', findings: [{ claim: 'The value is 42', support: 'source', evidenceIds: ['E1'] }], evidence, inspectedScope: ['/original/answer.ts'], scopeTruncated: false, unresolvedQuestions: ['Runtime was not observed.'], candidateKnowledgeChanges: [] } } };
function answer(store: Conversations) {
  const job = store.beginLive(null, 'What is the value?', { model: 'fixture', registration: 'fixture' }, undefined, undefined, ['/original']);
  store.finishLive(job.messageId, result, evidence); return job;
}

test('30-day expiry removes verbose main/child histories at the boundary but retains answers, citations and concise investigations across restart', () => {
  const f = fixture(); const job = answer(f.store);
  expect(f.store.retentionStatus()).toMatchObject({ verboseDays: 30, expiredAttempts: 0 });
  vi.setSystemTime(new Date('2026-01-30T23:59:59.999Z')); f.store.cleanupExpired();
  expect(f.store.liveContext(job.conversationId).history).toHaveLength(1);
  vi.setSystemTime(new Date('2026-01-31T00:00:00Z')); f.store.cleanupExpired();
  expect(f.store.liveContext(job.conversationId).history).toEqual([]);
  f.store.progressExploration(job.messageId, result.exploration!, evidence); // Late child checkpoint must not resurrect expired protocol.
  expect(f.store.exploration(job.messageId)).toBeUndefined();
  const message = f.store.workspace().selected!.messages.at(-1)!;
  expect(message).toMatchObject({ text: result.text, evidence, investigation: result.exploration!.result, verboseExpired: true, requests: 1 });
  expect(f.store.resumeContext(job.conversationId).history).toHaveLength(1);
  f.store.close(); const reopened = f.open();
  expect(reopened.workspace().selected!.messages.at(-1)).toEqual(message);
  expect(reopened.retentionStatus()).toMatchObject({ verboseDays: 30, expiredAttempts: 1, cleanupPending: false });
});

test('retention policy is configurable, local and prospective; expired transcripts never reappear', () => {
  const f = fixture(); const job = answer(f.store);
  for (const days of [-1, 0.5, 3651, NaN]) expect(() => f.store.setVerboseDays(days)).toThrow();
  f.store.setVerboseDays(null);
  vi.setSystemTime(new Date('2036-01-01T00:00:00Z')); f.store.cleanupExpired();
  expect(f.store.liveContext(job.conversationId).history).toHaveLength(1);
  f.store.setVerboseDays(0);
  expect(f.store.liveContext(job.conversationId).history).toHaveLength(1); // Saving policy alone does not delete.
  f.store.cleanupExpired(); f.store.setVerboseDays(null);
  f.store.finishLive(job.messageId, result, evidence); // A late save cannot restore expired content.
  expect(f.store.liveContext(job.conversationId).history).toEqual([]);
  f.store.close(); expect(f.open().retentionStatus()).toMatchObject({ verboseDays: null, expiredAttempts: 1 });
});

test('failed expiry rolls back; an interrupted checkpoint is visible and restart can finish without deleting retained evidence', () => {
  const f = fixture(); const job = answer(f.store); f.store.setVerboseDays(0);
  const fault = new DatabaseSync(f.path); cleanup.push(() => fault.close());
  fault.exec("CREATE TRIGGER expiry_fault BEFORE UPDATE OF history ON live_attempts BEGIN SELECT RAISE(ABORT, 'expiry failure'); END");
  expect(() => f.store.cleanupExpired()).toThrow('expiry failure');
  expect(f.store.liveContext(job.conversationId).history).toHaveLength(1);
  expect(f.store.retentionStatus()).toMatchObject({ expiredAttempts: 0, cleanupPending: false });
  fault.exec('DROP TRIGGER expiry_fault; BEGIN'); fault.prepare('SELECT * FROM live_attempts').all();
  expect(() => f.store.cleanupExpired()).toThrow(/checkpoint/i);
  expect(f.store.retentionStatus()).toMatchObject({ expiredAttempts: 1, cleanupPending: true });
  fault.exec('ROLLBACK'); f.store.close();
  const reopened = f.open(); reopened.recoverCleanup(); reopened.cleanupExpired();
  expect(reopened.retentionStatus()).toMatchObject({ expiredAttempts: 1, cleanupPending: false });
  expect(reopened.workspace().selected!.messages.at(-1)!.evidence).toEqual(evidence);
});

test('explicit conversation deletion is transactional, removes its evidence, and late results or restart cannot recreate it', () => {
  const f = fixture(); const job = answer(f.store); f.store.setMaxInvestigators(2);
  const other = answer(f.store);
  const fault = new DatabaseSync(f.path); cleanup.push(() => fault.close());
  fault.exec("CREATE TRIGGER deletion_fault BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'deletion failure'); END");
  expect(() => f.store.deleteConversation(job.conversationId)).toThrow('deletion failure');
  expect(f.store.workspace().conversations).toHaveLength(2);
  fault.exec('DROP TRIGGER deletion_fault');
  f.store.deleteConversation(job.conversationId);
  expect(f.store.hasAttempt(job.messageId)).toBe(false);
  f.store.finishLive(job.messageId, result, evidence); f.store.progressLive(job.messageId, 'Late', 'Late');
  expect(() => f.store.select(job.conversationId)).toThrow();
  f.store.deleteConversation(other.conversationId);
  expect(f.store.workspace().selected).toBeNull();
  f.store.close(); const reopened = f.open();
  expect(reopened.workspace()).toMatchObject({ conversations: [], selected: null, maxInvestigators: 2 });
  expect(() => reopened.retryTarget(job.messageId)).toThrow();
});

test('legacy attempts with unknown completion dates receive a fresh retention window without deleting authored state', () => {
  const f = fixture(); const job = answer(f.store); f.store.setMaxInvestigators(2); f.store.close();
  const legacy = new DatabaseSync(f.path);
  legacy.exec('ALTER TABLE live_attempts DROP COLUMN ended_at; ALTER TABLE live_attempts DROP COLUMN verbose_deleted_at; ALTER TABLE live_attempts DROP COLUMN ownership_uncertain; DROP TABLE local_cleanup;'); legacy.close();
  vi.setSystemTime(new Date('2036-01-01T00:00:00Z'));
  const migrated = f.open(); migrated.cleanupExpired();
  expect(migrated.liveContext(job.conversationId).history).toHaveLength(1);
  expect(migrated.workspace()).toMatchObject({ maxInvestigators: 2, selected: { title: 'What is the value?' } });
  vi.setSystemTime(new Date('2036-01-31T00:00:00Z')); migrated.cleanupExpired();
  expect(migrated.liveContext(job.conversationId).history).toEqual([]);
  expect(migrated.workspace().selected!.messages.at(-1)!.evidence).toEqual(evidence);
});

test('conversation deletion interrupted at checkpoint stays deleted and recovery never recreates its answer or evidence', () => {
  const f = fixture(); const job = answer(f.store);
  const reader = new DatabaseSync(f.path); reader.exec('BEGIN'); reader.prepare('SELECT * FROM live_attempts').all();
  expect(() => f.store.deleteConversation(job.conversationId)).toThrow(/checkpoint/i);
  expect(f.store.retentionStatus().cleanupPending).toBe(true);
  expect(f.store.hasAttempt(job.messageId)).toBe(false);
  reader.exec('ROLLBACK'); reader.close(); f.store.close();
  const reopened = f.open(); reopened.recoverCleanup();
  reopened.finishLive(job.messageId, result, evidence);
  expect(reopened.workspace().conversations).toEqual([]);
  expect(reopened.retentionStatus().cleanupPending).toBe(false);
});

test('cleanup and deletion refuse active work and preserve legacy physical ownership after verbose expiry', () => {
  const f = fixture();
  const active = f.store.beginLive(null, 'Legacy inspection', { model: 'fixture', registration: 'fixture' });
  expect(() => f.store.cleanupExpired()).toThrow(/active/i);
  expect(() => f.store.deleteConversation(active.conversationId)).toThrow(/active/i);
  f.store.finishLive(active.messageId, { ...result, history: [{ role: 'user', content: JSON.stringify({ citation: evidence[0].citation }), timestamp: 0 }] }, []);
  f.store.setVerboseDays(0); f.store.cleanupExpired();
  f.store.revoke(['/original']);
  expect(f.store.workspace().selected!.revokedSources).toEqual(['/original']);
  expect(f.store.resumeContext(active.conversationId).history).toEqual([]);
  f.store.purge(['/original']); f.store.recoverCleanup();
  expect(f.store.workspace().conversations).toEqual([]);
});
