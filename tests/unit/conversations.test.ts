import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Conversations } from '../../src/main/conversations';

const directories: string[] = [];
const stores: Conversations[] = [];
function open(path?: string) {
  if (!path) {
    const directory = mkdtempSync(join(tmpdir(), 'athena-test-'));
    directories.push(directory);
    path = join(directory, 'state.sqlite');
  }
  const store = new Conversations(path);
  stores.push(store);
  return { store, path };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('create and select conversations, retaining the selected transcript across restart', () => {
  const { store, path } = open();
  const first = store.create('First investigation');
  const job = store.begin(first.id, 'What can I try?');
  store.finish(job.messageId, 'complete', 'This is a local demonstration.');
  const second = store.create('Another investigation');
  store.select(first.id);
  store.close();

  const restarted = open(path).store.workspace();
  expect(restarted.conversations.map(conversation => conversation.title)).toEqual([
    'First investigation', 'Another investigation',
  ]);
  expect(restarted.selected?.id).toBe(first.id);
  expect(restarted.selected?.messages.map(({ role, text, status }) => ({ role, text, status }))).toEqual([
    { role: 'user', text: 'What can I try?', status: 'complete' },
    { role: 'assistant', text: 'This is a local demonstration.', status: 'complete' },
  ]);
  expect(second.id).not.toBe(first.id);
});

test('restart retains an interrupted question, marks its job cancelled, and allows a new job', () => {
  const { store, path } = open();
  const conversation = store.create('Interrupted work');
  store.begin(conversation.id, 'Keep this question');
  store.close();

  const restarted = open(path).store;
  expect(restarted.workspace().selected?.messages).toEqual([
    expect.objectContaining({ role: 'user', text: 'Keep this question', status: 'complete' }),
    expect.objectContaining({ role: 'assistant', status: 'cancelled', text: 'Demonstration interrupted. Send another message to try again.' }),
  ]);
  expect(() => restarted.begin(conversation.id, 'Try again')).not.toThrow();
});
