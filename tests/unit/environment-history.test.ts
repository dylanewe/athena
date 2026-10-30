import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations } from '../../src/main/conversations';
import type { Exploration } from '../../src/shared/investigation';
import type { Evidence, LiveResult } from '../../src/shared/live';

let directory: string, path: string, db: Conversations;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'athena-env-history-'));
  path = join(directory, 'conversations.sqlite'); db = new Conversations(path);
});
const canary = 'synthetic-history-canary-7';
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

test('unapproved sensitive derived results are withheld before any progress, history or title write', () => {
  const job = db.beginLive(null, 'Ordinary question', { model: 'fixture', registration: 'fixture' });
  db.progressLive(job.messageId, 'PASSWORD=' + canary, 'Receiving response');
  db.finishLive(job.messageId, { status: 'failed', text: 'PASSWORD=' + canary, title: canary, history: [], requests: 1, usageComplete: false }, []);
  expect(db.workspace().selected?.sealed).toBe(true);
  expect(readdirSync(directory).some(file => readFileSync(join(directory, file)).includes(canary))).toBe(false);
});

test('an abrupt restart retains only the safe marker, never ephemeral progress', () => {
  const job = db.beginLive(null, 'Inspect configuration', { model: 'fixture', registration: 'fixture' });
  db.markEphemeral(job.messageId);
  db.progressLive(job.messageId, canary, canary);
  db.close(); db = new Conversations(path);
  expect(db.workspace().selected?.messages.at(-1)).toMatchObject({ status: 'cancelled', ephemeral: true });
  expect(JSON.stringify(db.workspace()).includes(canary)).toBe(false);
  expect(db.liveContext(job.conversationId)).toEqual({ history: [], evidence: [] });
});

test('sealing precedes exposure; all derived persistence, follow-ups and restart recovery fail closed', () => {
  const job = db.beginLive(null, 'Inspect configuration', { model: 'fixture', registration: 'fixture' });
  db.markEphemeral(job.messageId);
  db.progressLive(job.messageId, canary, canary);
  const evidence: Evidence[] = [{ id: 'E1', text: canary, citation: { folder: '/fixture', path: '.env', repository: null, start: 1, end: 1, revision: null, contentIdentity: 'sha256:' + 'a'.repeat(64) } }];
  const exploration: Exploration = { history: [{ role: 'user', content: canary, timestamp: 0 }], result: { status: 'complete', findings: [{ claim: canary, support: 'source', evidenceIds: ['E1'] }], evidence, inspectedScope: [canary], scopeTruncated: false, unresolvedQuestions: [canary], candidateKnowledgeChanges: [canary] } };
  db.progressExploration(job.messageId, exploration, evidence);
  const result: LiveResult = { status: 'complete', text: canary, title: canary, history: [{ role: 'user', content: canary, timestamp: 0 }], exploration, requests: 3, usageComplete: false };
  db.finishLive(job.messageId, result, evidence);
  expect(db.workspace().selected?.messages.at(-1)).toMatchObject({ text: canary, ephemeral: true });
  expect(db.workspace().selected?.sealed).toBe(true);
  expect(db.liveContext(job.conversationId)).toEqual({ history: [], evidence: [] });
  expect(db.exploration(job.messageId)).toBeUndefined();
  expect(() => db.beginLive(job.conversationId, canary, db.binding(job.conversationId))).toThrow('new conversation');
  expect(readdirSync(directory).some(file => readFileSync(join(directory, file)).includes(canary))).toBe(false);
  db.close(); db = new Conversations(path);
  expect(JSON.stringify(db.workspace()).includes(canary)).toBe(false);
  expect(db.workspace().selected?.sealed).toBe(true);
});
