import { afterEach, expect, test } from 'vitest';
import { Conversations } from '../../src/main/conversations';
import { JobSupervisor } from '../../src/main/supervisor';
import { DesktopGateway, type Caller } from '../../src/main/bridge';

const trusted: Caller = { webContentsId: 1, isMainFrame: true, url: 'file:///athena/index.html' };
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
function setup() {
  const store = new Conversations(':memory:');
  const supervisor = new JobSupervisor(store, () => { throw new Error('No process in this test'); }, () => {});
  cleanups.push(() => { supervisor.cancel(); store.close(); });
  const bridge = new DesktopGateway(store, supervisor, { webContentsId: 1, url: trusted.url });
  return { store, bridge };
}

test('the trusted desktop can create and select a conversation through the narrow bridge', () => {
  const { bridge } = setup();
  const first = bridge.dispatch(trusted, 'create', { title: 'First' }).selected!;
  bridge.dispatch(trusted, 'create', { title: 'Second' });
  expect(bridge.dispatch(trusted, 'select', { conversationId: first.id }).selected?.title).toBe('First');
  expect(bridge.dispatch(trusted, 'workspace', undefined).conversations).toHaveLength(2);
});

test.each([
  ['create', null],
  ['create', { title: '' }],
  ['create', { title: '   ' }],
  ['create', { title: 'x'.repeat(101) }],
  ['create', { title: 42 }],
  ['create', { title: 'Valid', path: '/etc/passwd' }],
  ['select', { conversationId: '../../state.sqlite' }],
  ['send', { conversationId: '123', text: 'hello' }],
  ['workspace', { unexpected: true }],
  ['cancel', []],
  ['exec', { command: 'whoami' }],
])('rejects invalid bridge requests without changing state (case %#)', (operation, payload) => {
  const { bridge, store } = setup();
  expect(() => bridge.dispatch(trusted, operation, payload)).toThrow('Invalid desktop request');
  expect(store.workspace().conversations).toEqual([]);
});

test.each(['', ' ', 'x'.repeat(8001), 'secret\0value'])('rejects invalid messages before persisting a question (case %#)', text => {
  const { bridge } = setup();
  const conversationId = bridge.dispatch(trusted, 'create', { title: 'Demo' }).selected!.id;
  expect(() => bridge.dispatch(trusted, 'send', { conversationId, text })).toThrow('Invalid desktop request');
  expect(bridge.dispatch(trusted, 'workspace', undefined).selected?.messages).toEqual([]);
});

test.each([
  { ...trusted, webContentsId: 2 },
  { ...trusted, isMainFrame: false },
  { ...trusted, url: 'https://example.com' },
  { ...trusted, url: `${trusted.url}?untrusted` },
])('rejects an unauthorized window, frame, or document (case %#)', caller => {
  const { bridge, store } = setup();
  expect(() => bridge.dispatch(caller, 'create', { title: 'Untrusted' })).toThrow('Unauthorized');
  expect(store.workspace().conversations).toEqual([]);
});
