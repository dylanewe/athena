import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations } from '../../src/main/conversations';
import type { LiveResult } from '../../src/shared/live';

test('restart retains interrupted streamed text without replaying its unfinished context', () => {
  const directory = mkdtempSync(join(tmpdir(), 'athena-live-history-'));
  let db = new Conversations(join(directory, 'conversations.sqlite'));
  try {
    const job = db.beginLive(null, 'Question', { model: 'fixture-model', registration: 'fingerprint' });
    db.progressLive(job.messageId, 'Useful partial answer', 'Reading sources', { usage: { input: 10, output: 3, cachedInput: 0 }, requests: 1, usageComplete: false });
    db.close(); db = new Conversations(join(directory, 'conversations.sqlite'));
    expect(db.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'cancelled', text: expect.stringContaining('Useful partial answer'), usage: { input: 10, output: 3, cachedInput: 0 }, requests: 1, usageComplete: false });
    expect(db.liveContext(job.conversationId).history).toEqual([]);
    const interrupted = db.workspace().selected!.messages.at(-1)!.text;
    db.close(); db = new Conversations(join(directory, 'conversations.sqlite'));
    expect(db.workspace().selected!.messages.at(-1)!.text).toBe(interrupted);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

const binding = { model: 'fixture-model', registration: 'registration-fingerprint' };
const answer: LiveResult = { status: 'complete', text: 'Hello', history: [{ role: 'user', content: 'Hi', timestamp: 1 }], requests: 1, usageComplete: false };
test('restart marks checkpointed findings provisional and retains detailed exploration outside public history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'athena-exploration-'));
  let db = new Conversations(join(directory, 'conversations.sqlite'));
  try {
    const job = db.beginLive(null, 'Investigate', binding);
    db.progressLive(job.messageId, '', 'Investigator finished');
    const exploration = { history: [{ role: 'user' as const, content: 'PRIVATE_EXPLORATION', timestamp: 1 }], result: {
      status: 'complete' as const, findings: [], evidence: [], inspectedScope: ['repo/answer.ts'], scopeTruncated: false, unresolvedQuestions: [], candidateKnowledgeChanges: [],
    } };
    db.progressExploration(job.messageId, exploration, []);
    db.close(); db = new Conversations(join(directory, 'conversations.sqlite'));
    expect(db.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'cancelled', investigation: { status: 'partial' } });
    expect(db.exploration(job.messageId)?.history).toEqual(exploration.history);
    expect(db.exploration(job.messageId)?.result.status).toBe('partial');
    expect(JSON.stringify(db.workspace())).not.toContain('PRIVATE_EXPLORATION');
    expect(db.liveContext(job.conversationId).history).toEqual([]);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('new live conversations pin identity and retain completed context; demonstrations cannot acquire live authority', () => {
  const db = new Conversations(':memory:');
  const demo = db.begin(null, 'Demo'); db.finish(demo.messageId, 'complete', 'Local demo');
  const demoId = db.workspace().selected!.id;
  expect(() => db.binding(demoId)).toThrow('read-only');
  const job = db.beginLive(null, 'Hi', binding);
  db.finishLive(job.messageId, answer, []);
  expect(db.workspace().selected).toMatchObject({ kind: 'chatgpt', model: 'fixture-model' });
  expect(db.binding(job.conversationId)).toEqual(binding);
  expect(db.liveContext(job.conversationId).history).toEqual(answer.history);
  db.close();
});
test('explicit retry retains the interrupted attempt, avoids a duplicated question and uses only preceding completed context', () => {
  const db = new Conversations(':memory:');
  const first = db.beginLive(null, 'Hi', binding); db.finishLive(first.messageId, answer, []);
  const failed = db.beginLive(first.conversationId, 'Next', binding);
  db.finishLive(failed.messageId, { ...answer, status: 'partial', text: 'Incomplete', history: [] }, []);
  expect(db.liveContext(first.conversationId).history).toEqual(answer.history);
  const retry = db.beginLive(first.conversationId, '', binding, failed.messageId);
  expect(retry.prompt).toBe('Next');
  expect(db.workspace().selected!.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['Hi', 'Next']);
  db.finishLive(retry.messageId, { ...answer, status: 'cancelled' }, []);
  expect(() => db.beginLive(first.conversationId, '', binding, failed.messageId)).toThrow('latest');
  expect(() => db.beginLive(first.conversationId, 'Next', { ...binding, model: 'other' })).toThrow('identity');
  db.close();
});
