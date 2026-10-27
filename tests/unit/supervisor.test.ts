import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { Conversations } from '../../src/main/conversations';
import { JobSupervisor } from '../../src/main/supervisor';

// The process transport is an OS boundary; persistence and supervision are real.
class WorkerProcess extends EventEmitter {
  killed = false;
  spawned = true;
  postMessage() {}
  kill() {
    if (!this.spawned) return false;
    this.killed = true;
    return true;
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.useRealTimers();
});
function setup(path = ':memory:') {
  const store = new Conversations(path);
  const conversation = store.create('Demo');
  const workers: WorkerProcess[] = [];
  const supervisor = new JobSupervisor(store, () => {
    const worker = new WorkerProcess();
    workers.push(worker);
    return worker;
  }, () => {});
  cleanups.push(() => { supervisor.lifecycle('quit'); store.close(); });
  return { store, conversation, workers, supervisor };
}

test('a supervised demonstration returns visible progress and a durable result', () => {
  const { store, conversation, workers, supervisor } = setup();
  supervisor.start(conversation.id, 'Hello');
  workers[0].emit('message', { type: 'progress', text: 'Preparing demonstration…' });
  expect(store.workspace().selected?.messages.at(-1)).toMatchObject({ status: 'running', text: 'Preparing demonstration…' });
  workers[0].emit('message', { type: 'result', text: 'Local demonstration complete.' });
  expect(store.workspace().selected?.messages.at(-1)).toMatchObject({ status: 'complete', text: 'Local demonstration complete.' });
  expect(workers[0].killed).toBe(true);
});

test('a worker crash ends the job visibly and the next job can succeed', () => {
  const { store, conversation, workers, supervisor } = setup();
  supervisor.start(conversation.id, 'First try');
  workers[0].emit('exit', 1);
  expect(store.workspace().selected?.messages.at(-1)).toMatchObject({ status: 'failed' });
  supervisor.start(conversation.id, 'Try again');
  workers[0].emit('message', { type: 'result', text: 'Stale result' });
  workers[1].emit('message', { type: 'result', text: 'Recovered' });
  expect(store.workspace().selected?.messages.at(-1)).toMatchObject({ status: 'complete', text: 'Recovered' });
});

test.each([
  { type: 'failure' },
  null,
  { type: 'result', text: 42 },
  { type: 'result', text: 'x'.repeat(16_001) },
])('failed or malformed worker output ends the job safely (case %#)', event => {
  const { store, conversation, workers, supervisor } = setup();
  supervisor.start(conversation.id, 'Try this');
  expect(() => workers[0].emit('message', event)).not.toThrow();
  expect(store.workspace().selected?.messages.at(-1)).toMatchObject({ status: 'failed' });
  expect(workers[0].killed).toBe(true);
});

test('a spawn failure is persisted without leaving the conversation busy', () => {
  const store = new Conversations(':memory:');
  const supervisor = new JobSupervisor(store, () => { throw new Error('OS refused spawn'); }, () => {});
  cleanups.push(() => { supervisor.lifecycle('quit'); store.close(); });
  const conversation = store.create('No process');
  expect(() => supervisor.start(conversation.id, 'Hello')).not.toThrow();
  expect(store.workspace().selected?.messages.at(-1)).toMatchObject({ status: 'failed' });
  expect(store.workspace().activeConversationId).toBeNull();
});

test.each(['window-close', 'quit'] as const)('%s cancels work; minimize does not; late results cannot overwrite cancellation', event => {
  const { store, conversation, workers, supervisor } = setup();
  supervisor.start(conversation.id, 'Wait for me');
  supervisor.lifecycle('minimize');
  expect(store.workspace().selected?.messages.at(-1)?.status).toBe('running');
  expect(workers[0].killed).toBe(false);
  supervisor.lifecycle(event);
  workers[0].emit('message', { type: 'result', text: 'Too late' });
  expect(store.workspace().selected?.messages.at(-1)?.status).toBe('cancelled');
  expect(workers[0].killed).toBe(true);
});

test('cancelling before OS spawn still terminates the process when it starts', () => {
  const { store, conversation, workers, supervisor } = setup();
  supervisor.start(conversation.id, 'Cancel immediately');
  workers[0].spawned = false;
  supervisor.cancel();
  workers[0].spawned = true;
  workers[0].emit('spawn');
  expect(workers[0].killed).toBe(true);
  expect(store.workspace().selected?.messages.at(-1)?.status).toBe('cancelled');
});

test.each(['cancel', 'progress', 'result', 'exit'] as const)('a SQLite write failure during %s cannot bypass process cleanup, and saving can be retried', event => {
  const directory = mkdtempSync(join(tmpdir(), 'athena-locked-'));
  const path = join(directory, 'state.sqlite');
  const { store, conversation, workers, supervisor } = setup(path);
  const otherWriter = new DatabaseSync(path);
  cleanups.push(() => { otherWriter.close(); rmSync(directory, { recursive: true, force: true }); });
  supervisor.start(conversation.id, 'Keep my question');
  // Fault injection at the SQLite boundary, not a mock of the conversation service.
  otherWriter.exec('BEGIN IMMEDIATE');
  expect(() => {
    if (event === 'cancel') supervisor.cancel();
    else if (event === 'exit') workers[0].emit('exit', 1);
    else workers[0].emit('message', { type: event, text: 'Local response' });
  }).not.toThrow();
  expect(workers[0].killed).toBe(true);
  expect(supervisor.saveError).toContain('Retry saving');
  otherWriter.exec('ROLLBACK');
  supervisor.cancel();
  expect(supervisor.saveError).toBeUndefined();
  expect(store.workspace().selected?.messages.at(-1)?.status).toBe(
    event === 'cancel' ? 'cancelled' : event === 'result' ? 'complete' : 'failed',
  );
  expect(() => supervisor.start(conversation.id, 'Continue after recovery')).not.toThrow();
});

test('a hung utility process has a deadline rather than leaving the UI permanently busy', () => {
  vi.useFakeTimers();
  const { store, conversation, workers, supervisor } = setup();
  supervisor.start(conversation.id, 'Will this finish?');
  vi.advanceTimersByTime(30_001);
  expect(store.workspace().selected?.messages.at(-1)).toMatchObject({ status: 'failed' });
  expect(workers[0].killed).toBe(true);
});
