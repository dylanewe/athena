import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('the first prompt creates a titled conversation and its messages together, retained across restart', () => {
  const { store, path } = open();
  expect(store.workspace().conversations).toEqual([]);
  store.begin(null, '  Explain\n  how authentication works  ');
  const conversation = store.workspace().selected!;
  expect(conversation.title).toBe('Explain how authentication works');
  expect(conversation.messages).toEqual([
    expect.objectContaining({ role: 'user', text: 'Explain\n  how authentication works', status: 'complete' }),
    expect.objectContaining({ role: 'assistant', status: 'running' }),
  ]);
  store.close();
  const restarted = open(path).store.workspace();
  expect(restarted.conversations).toEqual([{ id: conversation.id, title: 'Explain how authentication works' }]);
  expect(restarted.selected?.id).toBe(conversation.id);
  expect(restarted.selected?.messages[0].text).toBe('Explain\n  how authentication works');
});

test('long first prompts get bounded Unicode-safe titles that later messages do not rename', () => {
  const { store } = open();
  const first = store.begin(null, '🔎'.repeat(120));
  const conversation = store.workspace().selected!;
  expect(conversation.title).toBe('🔎'.repeat(99) + '…');
  store.finish(first.messageId, 'complete', 'Local response');
  store.begin(conversation.id, 'A different follow-up topic');
  expect(store.workspace().selected?.title).toBe(conversation.title);
});

test.each(['', '   ', 'x'.repeat(8001), 'secret\0value'])('invalid first prompts never create a sidebar entry (case %#)', text => {
  const { store } = open();
  expect(() => store.begin(null, text)).toThrow();
  expect(store.workspace().conversations).toEqual([]);
  expect(store.workspace().selected).toBeNull();
});

test('a failed first-message transaction leaves no new conversation and preserves the prior selection', () => {
  const { store, path } = open();
  const previous = store.begin(null, 'Previously saved');
  store.finish(previous.messageId, 'complete', 'Previous response');
  const before = store.workspace();
  // Inject a write failure at the SQLite boundary after conversation/selection insertion.
  const fault = new DatabaseSync(path);
  try {
    fault.exec("CREATE TRIGGER fail_first_reply BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;");
    expect(() => store.begin(null, 'New draft')).toThrow();
    expect(store.workspace()).toEqual(before);
    fault.exec('DROP TRIGGER fail_first_reply');
    store.begin(null, 'New draft');
    expect(store.workspace().conversations).toHaveLength(2);
    expect(store.workspace().selected?.title).toBe('New draft');
  } finally { fault.close(); }
});

test('create and select conversations, retaining the selected transcript across restart', () => {
  const { store, path } = open();
  const job = store.begin(null, 'What can I try?');
  const first = store.workspace().selected!;
  store.finish(job.messageId, 'complete', 'This is a local demonstration.');
  store.begin(null, 'Another investigation');
  const second = store.workspace().selected!;
  store.select(first.id);
  store.close();

  const restarted = open(path).store.workspace();
  expect(restarted.conversations.map(conversation => conversation.title)).toEqual([
    'What can I try?', 'Another investigation',
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
  store.begin(null, 'Keep this question');
  const conversation = store.workspace().selected!;
  store.close();

  const restarted = open(path).store;
  expect(restarted.workspace().selected?.messages).toEqual([
    expect.objectContaining({ role: 'user', text: 'Keep this question', status: 'complete' }),
    expect.objectContaining({ role: 'assistant', status: 'cancelled', text: 'Demonstration interrupted. Send another message to try again.' }),
  ]);
  expect(() => restarted.begin(conversation.id, 'Try again')).not.toThrow();
});
