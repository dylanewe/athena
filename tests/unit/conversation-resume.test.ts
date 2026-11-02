import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Conversations } from '../../src/main/conversations';
import { contextEvidenceIds } from '../../src/worker/agent-context';
import type { Evidence, LiveResult } from '../../src/shared/live';

const binding = { model: 'first-model', registration: 'fixture-registration' };
const evidence: Evidence = { id: 'E1', text: 'export const value = 1;', citation: { folder: '/approved', repository: null, path: 'value.ts', start: 1, end: 1, revision: 'old-revision', contentIdentity: 'sha256:original' } };
const answer: LiveResult = { status: 'complete', text: 'Historical value is 1 [E1].', history: [{ role: 'user', content: 'PRIVATE_PROTOCOL_AND_COMPACTED_SUMMARY', timestamp: 1 }], requests: 2, usageComplete: true };

test('restart restores selected scope and original evidence while reconstructing only bounded public context', () => {
  const directory = mkdtempSync(join(tmpdir(), 'athena-resume-'));
  const path = join(directory, 'state.sqlite');
  let db = new Conversations(path);
  try {
    const scope = { repositories: [{ name: 'repo', path: '/approved/repo', root: '/approved', documentationRoots: ['notes'] }] };
    const first = db.beginLive(null, 'Original question ' + 'q'.repeat(5000), binding, undefined, scope);
    db.finishLive(first.messageId, answer, [evidence]);
    const other = db.beginLive(null, 'Other conversation', binding); db.finishLive(other.messageId, answer, []);
    db.select(first.conversationId);
    db.close(); db = new Conversations(path);
    expect(db.workspace().selected).toMatchObject({ id: first.conversationId, scope, messages: [{ role: 'user' }, { evidence: [evidence], model: 'first-model' }] });
    const context = db.resumeContext(first.conversationId);
    expect(JSON.stringify(context.history)).toContain('Historical value is 1 [E1]');
    expect(JSON.stringify(context.history)).not.toContain('PRIVATE_PROTOCOL');
    expect(JSON.stringify(context.history)).not.toContain('export const value');
    expect(JSON.stringify(context.history)).not.toContain('Other conversation');
    expect(Buffer.byteLength(JSON.stringify(context.history))).toBeLessThan(10000);
    expect(contextEvidenceIds(context.history).size).toBe(0);
    const next = db.beginLive(first.conversationId, 'New question', { ...binding, model: 'second-model' });
    db.finishLive(next.messageId, { ...answer, text: 'Second answer' }, []);
    expect(db.workspace().selected!.scope).toEqual(scope);
    expect(db.workspace().selected!.messages.find(message => message.id === first.messageId)).toMatchObject({ evidence: [evidence], model: 'first-model' });
    expect(JSON.stringify(db.resumeContext(first.conversationId).history)).not.toContain('Original question');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('pre-#18 profiles migrate original model identities and selected build scope before switching models', () => {
  const directory = mkdtempSync(join(tmpdir(), 'athena-resume-migration-'));
  const path = join(directory, 'state.sqlite');
  let db = new Conversations(path);
  try {
    const scope = { repositories: [{ name: 'repo', path: '/approved/repo', root: '/approved', documentationRoots: [] }] };
    const first = db.beginLive(null, 'Question', binding, undefined, scope); db.finishLive(first.messageId, answer, [evidence]);
    db.close();
    const legacy = new DatabaseSync(path);
    legacy.exec('ALTER TABLE live_attempts DROP COLUMN binding; ALTER TABLE conversations DROP COLUMN scope; ALTER TABLE conversations DROP COLUMN chatgpt_registration;'); legacy.close();
    db = new Conversations(path);
    expect(db.workspace().selected!.scope).toEqual(scope);
    expect(db.chatgptRegistration(first.conversationId)).toBe('fixture-registration');
    const next = db.beginLive(first.conversationId, 'Next', { ...binding, model: 'new-model' }); db.finishLive(next.messageId, answer, []);
    expect(db.workspace().selected!.messages.find(message => message.id === first.messageId)).toMatchObject({ model: 'first-model', evidence: [evidence] });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('restart before the first checkpoint still marks interruption and explicit retry creates a new attempt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'athena-resume-interrupted-'));
  const path = join(directory, 'state.sqlite');
  let db = new Conversations(path);
  try {
    const job = db.beginLive(null, 'Do work', binding);
    db.close(); db = new Conversations(path);
    expect(db.workspace().activeConversationId).toBeNull();
    expect(db.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'cancelled', interrupted: true, usageComplete: false });
    expect(db.resumeContext(job.conversationId).history).toEqual([]);
    const retry = db.beginLive(job.conversationId, '', { ...binding, model: 'second-model' }, job.messageId);
    expect(retry.messageId).not.toBe(job.messageId);
    expect(retry.prompt).toBe('Do work');
    expect(db.workspace().selected!.messages.filter(message => message.role === 'user')).toHaveLength(1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
