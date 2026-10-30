import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiSettings } from '../../src/main/api-settings';
import { Conversations } from '../../src/main/conversations';
import { Sources } from '../../src/main/sources';
import { LiveSupervisor } from '../../src/main/live-supervisor';
import type { ChatGPTSettings } from '../../src/main/chatgpt-settings';
import { runLiveAgent } from '../../src/worker/live-agent';
import type { LiveParentMessage, LiveStart } from '../../src/shared/live';
import { FOLDER_CONSENT } from '../../src/shared/inventory';

let directory: string, root: string, settings: ApiSettings, conversations: Conversations, sources: Sources, supervisor: LiveSupervisor;
let http: typeof fetch, requests: { url: string; body: Record<string, unknown>; headers: Headers }[], workers: Worker[], reservations: number[];
let scripts: string[];
const response = (text?: string, tool?: string, args?: unknown) => [
  { choices: [{ index: 0, delta: { role: 'assistant', ...(tool ? { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: text }) }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
].map(value => 'data: ' + JSON.stringify({ id: 'test', ...value }) + '\n\n').join('') + 'data: [DONE]\n\n';
function configuration(name = 'Main one', endpoint = 'https://main.example/v1') {
  const model = (id: string, name: string) => ({ id, name, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }, compat: { maxTokensField: 'max_tokens' } });
  return JSON.stringify({ providers: {
    main: { api: 'openai-completions', baseUrl: endpoint, apiKey: 'fake-main-key', models: [model('main-one', name)] },
    investigator: { api: 'openai-completions', baseUrl: 'https://investigator.example/v1', apiKey: 'fake-investigator-key', models: [model('investigator-one', 'Investigator one')] },
  } });
}
class Worker extends EventEmitter {
  controller = new AbortController(); next = 0; job?: LiveStart;
  pending = new Map<number, (message: Extract<LiveParentMessage, { type: 'reply' }>) => void>();
  postMessage(message: LiveParentMessage) {
    if (message.type === 'reply') { this.pending.get(message.id)?.(message); this.pending.delete(message.id); return; }
    this.job = message.job;
    void runLiveAgent(message.job, {
      access: async () => { throw new Error('OAuth must not be used'); },
      apiAccess: async (role, contextBytes) => { const r = await this.rpc('access', { role, contextBytes }); if (!r.grant) throw new Error(); return r.grant; },
      source: async (operation, input) => { const r = await this.rpc('source', { operation, input }); if (!r.source) throw new Error(); return r.source; },
      inspect: async ids => { const r = await this.rpc('inspect', { ids }); if (!r.evidence) throw new Error(); return r.evidence; },
      checkpoint: checkpoint => this.emit('message', { type: 'checkpoint', checkpoint }),
      progress: (text, activity) => this.emit('message', { type: 'progress', text, activity }),
      reportUsage: (request, usage) => this.emit('message', { type: 'usage', request, usage }),
    }, this.controller.signal, (...args) => http(...args)).then(result => this.emit('message', { type: 'result', result }));
  }
  rpc(type: string, extra = {}) { return new Promise<Extract<LiveParentMessage, { type: 'reply' }>>(resolve => { const id = ++this.next; this.pending.set(id, resolve); queueMicrotask(() => this.emit('message', { type, id, ...extra })); }); }
  kill() { this.controller.abort(); return true; }
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-api-live-'))); root = join(directory, 'repo'); mkdirSync(root); writeFileSync(join(root, 'answer.ts'), 'export const answer = 42;\n');
  conversations = new Conversations(join(directory, 'conversations.sqlite'));
  const inventory = { snapshot: () => ({ roots: [{ path: root, consent: FOLDER_CONSENT, acceptedAt: 'now', includedLocations: [] }], repositories: [], candidates: [], discovery: { status: 'complete' as const, visited: 0, current: '', nonGitFiles: 1, failures: [] } }) };
  sources = new Sources(':memory:', inventory);
  reservations = [];
  settings = new ApiSettings(join(directory, 'api.sqlite'), { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => Buffer.from(value).toString() }, async () => 'fake-helper', {}, n => reservations.push(n));
  settings.configure(configuration()); settings.select('api-key', 'main/main-one', 'investigator/investigator-one');
  for (const d of settings.snapshot().destinations) settings.approveDestination(d.id, true);
  workers = []; requests = []; scripts = [response('Answer')];
  http = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    if (!scripts.length) throw new Error('Unexpected request');
    return new Response(scripts.shift(), { headers: { 'content-type': 'text/event-stream' } });
  };
  const noOAuth = { snapshot: vi.fn(() => { throw new Error('OAuth unavailable'); }) } as unknown as ChatGPTSettings;
  supervisor = new LiveSupervisor(conversations, noOAuth, sources, inventory, () => { const w = new Worker(); workers.push(w); return w; }, () => {}, settings);
});
afterEach(() => { supervisor.cancel(); sources.close(); conversations.close(); settings.close(); rmSync(directory, { recursive: true, force: true }); });
async function idle() { await expect.poll(() => conversations.workspace().activeConversationId).toBeNull(); }

test('real Pi agents use separate pinned API-key providers, preserve source boundaries and reserve each request', async () => {
  scripts = [response(undefined, 'investigate', { question: 'Find the answer' }), response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 }),
    response(undefined, 'finish_investigation', { findings: [{ claim: 'Value is 42', support: 'source', evidenceIds: ['E1'] }], unresolvedQuestions: ['Runtime not observed'], candidateKnowledgeChanges: [] }), response('Value is 42 [E1].')];
  supervisor.start(null, 'Find the answer'); await idle();
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'complete', text: 'Value is 42 [E1].', requests: 4, investigation: { status: 'complete' } });
  expect(requests.map(r => r.body.model)).toEqual(['main-one', 'investigator-one', 'investigator-one', 'main-one']);
  expect(requests.map(r => r.url)).toEqual(['https://main.example/v1/chat/completions', 'https://investigator.example/v1/chat/completions', 'https://investigator.example/v1/chat/completions', 'https://main.example/v1/chat/completions']);
  expect(requests.map(r => r.headers.get('authorization'))).toEqual(['Bearer fake-main-key', 'Bearer fake-investigator-key', 'Bearer fake-investigator-key', 'Bearer fake-main-key']);
  expect(requests.every(r => r.body.max_tokens === 1024)).toBe(true); expect(reservations).toHaveLength(4);
  const binding = conversations.binding(conversations.workspace().selected!.id);
  expect(JSON.stringify(binding)).not.toContain('fake-main-key');
  expect(binding.apiKey?.investigator.model.id).toBe('investigator-one');
});

test('API-key outbound environment approval propagates across separately pinned roles without persisting echoes or bypassing reservations', async () => {
  const canary = 'synthetic-api-environment-7';
  writeFileSync(join(root, '.env'), 'PASSWORD=' + canary);
  scripts = [response(undefined, 'investigate', { question: 'Read configuration' }), response(undefined, 'sources_read', { root, path: '.env' }),
    response(undefined, 'finish_investigation', { findings: [{ claim: 'PASSWORD=' + canary, support: 'source', evidenceIds: ['E1'] }], unresolvedQuestions: [], candidateKnowledgeChanges: [] }), response('PASSWORD=' + canary)];
  supervisor.start(null, 'Read configuration');
  await expect.poll(() => supervisor.environmentPermissions().length).toBe(1);
  supervisor.environment(supervisor.environmentPermissions()[0].id, 'external'); await idle();
  expect(requests.map(r => r.body.model)).toEqual(['main-one', 'investigator-one', 'investigator-one', 'main-one']);
  expect(reservations).toHaveLength(4);
  expect(JSON.stringify(requests[2].body).includes(canary)).toBe(true);
  expect(JSON.stringify(requests[3].body).includes(canary)).toBe(true);
  const conversation = conversations.workspace().selected!;
  expect(conversation.messages.at(-1)).toMatchObject({ status: 'complete', ephemeral: true });
  expect(conversation.messages.at(-1)?.text.includes(canary)).toBe(true);
  expect(conversations.liveContext(conversation.id)).toEqual({ history: [], evidence: [] });
  conversations.close(); conversations = new Conversations(join(directory, 'conversations.sqlite'));
  expect(JSON.stringify(conversations.workspace()).includes(canary)).toBe(false);
});

test('edits during a job and between jobs never change an existing conversation; new conversations use new settings', async () => {
  const original = http;
  http = async (...args) => { settings.configure(configuration('Changed', 'https://changed.example/v1')); return original(...args); };
  scripts = [response(undefined, 'set_conversation_title', { title: 'Pinned title' }), response('First answer')];
  supervisor.start(null, 'First question'); await idle();
  expect(requests.every(r => r.url.startsWith('https://main.example/'))).toBe(true);
  const id = conversations.workspace().selected!.id;
  http = original; scripts = [response('Second answer')]; supervisor.start(id, 'Second question'); await idle();
  expect(requests.at(-1)!.url).toBe('https://main.example/v1/chat/completions');
  expect(workers.at(-1)!.job!.apiKey!.conversation.model.name).toBe('Main one');
  expect(() => supervisor.start(null, 'New question')).toThrow('Approve');
  const newDestination = settings.snapshot().destinations.find(d => d.endpoint.startsWith('https://changed.example'))!; settings.approveDestination(newDestination.id, true);
  scripts = [response('New conversation')]; supervisor.start(null, 'New question'); await idle();
  expect(requests.at(-1)!.url).toBe('https://changed.example/v1/chat/completions');
});

test('revoked consent/credentials block old transcripts and retry without starting a provider worker', async () => {
  supervisor.start(null, 'Question'); await idle(); const id = conversations.workspace().selected!.id;
  settings.approveDestination(settings.snapshot().destinations.find(d => d.provider === 'main')!.id, false);
  expect(() => supervisor.start(id, 'Follow up')).toThrow('Approve'); expect(workers).toHaveLength(1);
  settings.approveDestination(settings.snapshot().destinations.find(d => d.provider === 'main')!.id, true);
  settings.revokeCredential('main'); expect(() => supervisor.start(id, 'Follow up')).toThrow('revoked'); expect(workers).toHaveLength(1);
});

test('provider failure does not retry, fall back, or start another role request', async () => {
  http = async () => { requests.push({ url: 'failed', body: {}, headers: new Headers() }); return new Response('secret raw provider error', { status: 401 }); };
  supervisor.start(null, 'Question'); await idle();
  expect(requests).toHaveLength(1); expect(reservations).toHaveLength(1);
  expect(conversations.workspace().selected!.messages.at(-1)!.status).toBe('failed');
  expect(JSON.stringify(conversations.workspace())).not.toContain('secret raw provider error');
});

test('rechecks folder/secret boundaries and withholds protected environment files from HTTP', async () => {
  writeFileSync(join(root, '.env'), 'SECRET_KEY=never-send');
  scripts = [response(undefined, 'investigate', { question: 'Read source' }), response(undefined, 'sources_read', { root, path: '.env' }), response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: ['File withheld'], candidateKnowledgeChanges: [] }), response('File withheld.')];
  supervisor.start(null, 'Read source');
  await expect.poll(() => supervisor.environmentPermissions().length).toBe(1);
  supervisor.environment(supervisor.environmentPermissions()[0].id, 'deny');
  await idle();
  expect(JSON.stringify(requests)).not.toContain('never-send');
  expect(conversations.workspace().selected!.messages.at(-1)!.evidence).toEqual([]);
});
