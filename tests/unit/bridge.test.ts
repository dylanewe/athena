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

test('a first send creates and selects a locally titled conversation even if the demo cannot start', () => {
  const { bridge } = setup();
  const workspace = bridge.dispatch(trusted, 'send', { conversationId: null, text: '  Explain authentication  ' });
  expect(workspace.conversations).toEqual([{ id: workspace.selected!.id, title: 'Explain authentication' }]);
  expect(workspace.selected?.messages).toEqual([
    expect.objectContaining({ role: 'user', text: 'Explain authentication' }),
    expect.objectContaining({ role: 'assistant', status: 'failed' }),
  ]);
});

test('the trusted desktop can start and select conversations through the narrow bridge', () => {
  const { bridge } = setup();
  const first = bridge.dispatch(trusted, 'send', { conversationId: null, text: 'First' }).selected!;
  bridge.dispatch(trusted, 'send', { conversationId: null, text: 'Second' });
  expect(bridge.dispatch(trusted, 'select', { conversationId: first.id }).selected?.title).toBe('First');
  expect(bridge.dispatch(trusted, 'workspace', undefined).conversations).toHaveLength(2);
});

test.each([
  ['create', null],
  ['create', { title: '' }],
  ['create', { title: '   ' }],
  ['create', { title: 'x'.repeat(101) }],
  ['create', { title: 42 }],
  ['create', { title: 'Valid' }],
  ['create', { title: 'Valid', path: '/etc/passwd' }],
  ['send', { text: 'Missing target' }],
  ['send', { conversationId: undefined, text: 'Undefined is not a new conversation' }],
  ['send', { conversationId: null, text: 'Valid', title: 'User chosen' }],
  ['select', { conversationId: '../../state.sqlite' }],
  ['send', { conversationId: '123', text: 'hello' }],
  ['workspace', { unexpected: true }],
  ['environment', { id: '../../.env', action: 'external' }],
  ['environment', { id: '00000000-0000-4000-8000-000000000000', action: 'external', path: '.env' }],
  ['cancel', []],
  ['exec', { command: 'whoami' }],
])('rejects invalid bridge requests without changing state (case %#)', (operation, payload) => {
  const { bridge, store } = setup();
  expect(() => bridge.dispatch(trusted, operation, payload)).toThrow('Invalid desktop request');
  expect(store.workspace().conversations).toEqual([]);
});

test.each(['', ' ', 'x'.repeat(8001), 'secret\0value'])('rejects invalid messages before persisting a question (case %#)', text => {
  const { bridge } = setup();
  expect(() => bridge.dispatch(trusted, 'send', { conversationId: null, text })).toThrow('Invalid desktop request');
  expect(bridge.dispatch(trusted, 'workspace', undefined).conversations).toEqual([]);
  const conversation = bridge.dispatch(trusted, 'send', { conversationId: null, text: 'First prompt' }).selected!;
  expect(() => bridge.dispatch(trusted, 'send', { conversationId: conversation.id, text })).toThrow('Invalid desktop request');
  expect(bridge.dispatch(trusted, 'workspace', undefined).selected?.messages).toEqual(conversation.messages);
});

test.each([
  { ...trusted, webContentsId: 2 },
  { ...trusted, isMainFrame: false },
  { ...trusted, url: 'https://example.com' },
  { ...trusted, url: `${trusted.url}?untrusted` },
])('rejects an unauthorized window, frame, or document (case %#)', caller => {
  const { bridge, store } = setup();
  expect(() => bridge.dispatch(caller, 'send', { conversationId: null, text: 'Untrusted' })).toThrow('Unauthorized');
  expect(() => bridge.dispatch(caller, 'environment', { id: '00000000-0000-4000-8000-000000000000', action: 'external' })).toThrow('Unauthorized');
  expect(store.workspace().conversations).toEqual([]);
});
