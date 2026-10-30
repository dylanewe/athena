import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations } from '../../src/main/conversations';
import { ChatGPTSettings } from '../../src/main/chatgpt-settings';
import { ChatGPTStore } from '../../src/main/chatgpt-store';
import { ISSUER, SCOPES, type OAuthProtocol, type Registration } from '../../src/main/chatgpt-protocol';
import { Sources } from '../../src/main/sources';
import { LiveSupervisor } from '../../src/main/live-supervisor';
import { runLiveAgent } from '../../src/worker/live-agent';
import { LIVE_LIMITS, type LiveParentMessage } from '../../src/shared/live';
import type { InventorySnapshot } from '../../src/shared/inventory';
import { FOLDER_CONSENT } from '../../src/shared/inventory';

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const complete = frame({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } } });
function textResponse(text: string) {
  const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
  return frame({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }) + frame({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }) + frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text }) + frame({ type: 'response.output_item.done', output_index: 0, item }) + complete;
}
function toolResponse(root: string, terminal = true, path = 'answer.ts') {
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'sources_read', arguments: JSON.stringify({ root, path, start: 1, end: 1 }) };
  return frame({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }) + frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }) + frame({ type: 'response.output_item.done', output_index: 0, item }) + (terminal ? complete : '');
}
let directory: string, root: string, db: Conversations, chatgpt: ChatGPTSettings, sources: Sources, jobs: LiveSupervisor;
let requests: Record<string, unknown>[], workers: Worker[], http: typeof fetch, oauth: OAuthProtocol, store: ChatGPTStore;
class Worker extends EventEmitter {
  killed = false;
  controller = new AbortController();
  next = 0;
  pending = new Map<number, (message: Extract<LiveParentMessage, { type: 'reply' }>) => void>();
  postMessage(message: LiveParentMessage) {
    if (message.type === 'reply') { this.pending.get(message.id)?.(message); this.pending.delete(message.id); return; }
    void runLiveAgent(message.job, {
      access: async () => { const reply = await this.rpc('access'); if (!reply.token) throw new Error(); return reply.token; },
      source: async (operation, input) => { const reply = await this.rpc('source', { operation, input }); if (!reply.source) throw new Error(); return reply.source; },
      progress: (text, activity) => this.emit('message', { type: 'progress', text, activity }),
      reportUsage: (request, usage) => this.emit('message', { type: 'usage', request, usage }),
    }, this.controller.signal, (...args) => http(...args)).then(result => this.emit('message', { type: 'result', result }));
  }
  rpc(type: string, extra = {}) { return new Promise<Extract<LiveParentMessage, { type: 'reply' }>>(resolve => { const id = ++this.next; this.pending.set(id, resolve); queueMicrotask(() => this.emit('message', { type, id, ...extra })); }); }
  kill() { this.killed = true; this.controller.abort(); return true; }
}
async function idle() { await expect.poll(() => db.workspace().activeConversationId).toBeNull(); }
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-live-'))); root = join(directory, 'repo'); mkdirSync(root); writeFileSync(join(root, 'answer.ts'), 'export const answer = 42;\n');
  const snapshot: InventorySnapshot = { roots: [{ path: root, consent: FOLDER_CONSENT, acceptedAt: 'now', includedLocations: [] }], repositories: [], candidates: [], discovery: { status: 'complete', visited: 0, current: '', nonGitFiles: 1, failures: [] } };
  const inventory = { snapshot: () => structuredClone(snapshot) };
  sources = new Sources(':memory:', inventory); db = new Conversations(':memory:');
  store = new ChatGPTStore(join(directory, 'chatgpt.sqlite'), { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => Buffer.from(value).toString() });
  const registration: Registration = { clientId: 'fixture-client', issuer: ISSUER, subject: 'fixture-subject', tokens: { idToken: 'verified', accessToken: 'fixture-oauth', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600_000, scopes: SCOPES } };
  oauth = { login: vi.fn(async () => structuredClone(registration)), refresh: vi.fn(async () => structuredClone(registration)), catalog: vi.fn(async () => [{ id: 'fixture-model', name: 'Fixture' }, { id: 'other-model', name: 'Other' }]), revoke: vi.fn(async () => true) };
  chatgpt = new ChatGPTSettings(store, oauth, { start: () => { throw new Error('Test transport must not be used'); } });
  chatgpt.connect(); await expect.poll(() => chatgpt.snapshot().activity).toBe('idle'); chatgpt.selectModel('fixture-model');
  requests = []; workers = [];
  http = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Response(new TextEncoder().encode(textResponse('Hello from ChatGPT'))); };
  jobs = new LiveSupervisor(db, chatgpt, sources, inventory, () => { const worker = new Worker(); workers.push(worker); return worker; }, () => {});
});
afterEach(async () => { vi.useRealTimers(); jobs.cancel(); await chatgpt.close(); sources.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

test('real Pi agent and adapter produce multi-turn durable answers with pinned identity and usage', async () => {
  jobs.start(null, 'Hello'); await idle();
  const first = db.workspace().selected!;
  expect(first.messages.at(-1)).toMatchObject({ status: 'complete', text: 'Hello from ChatGPT', requests: 1, usage: { input: 10, output: 3, cachedInput: 0 } });
  chatgpt.selectModel('other-model');
  jobs.start(first.id, 'Follow up'); await idle();
  expect(requests[1].model).toBe('fixture-model');
  expect(JSON.stringify(requests[1])).toContain('Hello from ChatGPT');
  expect(JSON.stringify(requests)).not.toContain('fixture-oauth');
  expect(workers.every(worker => worker.killed)).toBe(true);
});

test('agent tools use the real global source boundary, retain evidence and reject stale history before another model request', async () => {
  http = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(new TextEncoder().encode(requests.length === 1 ? toolResponse(root) : textResponse('The value is 42 [E1], answer.ts:1.')));
  };
  jobs.start(null, 'Find the answer'); await idle();
  const conversation = db.workspace().selected!;
  expect(conversation.messages.at(-1)).toMatchObject({ status: 'complete', evidence: [{ id: 'E1', text: 'export const answer = 42;' }], requests: 2 });
  expect(JSON.stringify(requests[1])).toContain('export const answer = 42;');
  writeFileSync(join(root, 'answer.ts'), 'export const answer = 43;\n');
  jobs.start(conversation.id, 'Explain further'); await idle();
  expect(requests).toHaveLength(2);
  expect(db.workspace().selected!.messages.at(-1)?.text).toContain('Saved evidence changed');
});

test('a complete tool call in an unterminated model stream cannot execute a source tool', async () => {
  const read = vi.spyOn(sources, 'run');
  http = async () => new Response(new TextEncoder().encode(toolResponse(root, false)));
  jobs.start(null, 'Find the answer'); await idle();
  expect(read).not.toHaveBeenCalled();
  expect(db.workspace().selected!.messages.at(-1)?.status).toBe('failed');
});

test('source mutation during an answer retains a partial result instead of claiming a coherent version', async () => {
  http = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 2) writeFileSync(join(root, 'answer.ts'), 'changed\n');
    return new Response(new TextEncoder().encode(requests.length === 1 ? toolResponse(root) : textResponse('The answer is 42 [E1].')));
  };
  jobs.start(null, 'Find the answer'); await idle();
  expect(db.workspace().selected!.messages.at(-1)?.status).toBe('partial');
  expect(db.liveContext(db.workspace().selected!.id).history).toEqual([]);
});

test('explicit retry does not replay incomplete attempts or duplicate the user prompt', async () => {
  http = async () => new Response('', { status: 503 });
  jobs.start(null, 'Hello'); await idle();
  const failed = db.workspace().selected!;
  http = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Response(new TextEncoder().encode(textResponse('Retry worked'))); };
  jobs.retry(failed.messages.at(-1)!.id); await idle();
  expect(db.workspace().selected!.messages.filter(m => m.role === 'user')).toHaveLength(1);
  expect(db.workspace().selected!.messages.at(-1)?.status).toBe('complete');
  expect(JSON.stringify(requests)).not.toContain('temporarily unavailable');
});

test('50 model requests stops a looping investigator without a hidden 51st request', async () => {
  http = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Response(new TextEncoder().encode(toolResponse(root))); };
  jobs.start(null, 'Keep searching'); await idle();
  expect(requests).toHaveLength(50);
  expect(db.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'limit', requests: 50 });
});

test.each(['.env', '../outside.ts'])('tool calls cannot bypass source policy for %s', async path => {
  writeFileSync(join(root, '.env'), 'password=real-private-value');
  writeFileSync(join(directory, 'outside.ts'), 'outside-private-content');
  http = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Response(new TextEncoder().encode(requests.length === 1 ? toolResponse(root, true, path) : textResponse('Source access was denied.'))); };
  jobs.start(null, 'Read the file'); await idle();
  expect(JSON.stringify(requests)).not.toMatch(/real-private-value|outside-private-content/);
  expect(db.workspace().selected!.messages.at(-1)?.evidence).toEqual([]);
});

test('suspected credentials in the user prompt are withheld before persistence or transport', () => {
  expect(() => jobs.start(null, 'password=actual-private-value')).toThrow('secret checks');
  expect(db.workspace().conversations).toEqual([]);
  expect(workers).toEqual([]);
});

test('cancelling a pending conversation refresh keeps rotation serialized ahead of disconnect', async () => {
  const record = store.read()!; record.registration!.tokens!.expiresAt = 0; store.write(record);
  let rotate!: () => void;
  oauth.refresh = vi.fn(() => new Promise<Registration>(resolve => { rotate = () => resolve({ ...record.registration!, tokens: { ...record.registration!.tokens!, accessToken: 'rotated-oauth', refreshToken: 'rotated-refresh', expiresAt: Date.now() + 3600_000 } }); }));
  jobs.start(null, 'Will cancel before generation');
  await expect.poll(() => vi.mocked(oauth.refresh).mock.calls.length).toBe(1);
  chatgpt.disconnect(); await idle();
  expect(oauth.revoke).not.toHaveBeenCalled();
  rotate();
  await expect.poll(() => chatgpt.snapshot().activity).toBe('idle');
  expect(oauth.revoke).toHaveBeenCalledWith(expect.objectContaining({ tokens: expect.objectContaining({ refreshToken: 'rotated-refresh' }) }), expect.any(AbortSignal));
  expect(store.read()!.registration!.tokens).toBeUndefined();
  expect(requests).toEqual([]);
});

test('refresh authority is renewed per model step, never sent to the renderer or model context', async () => {
  const record = store.read()!;
  oauth.refresh = vi.fn(async () => ({ ...record.registration!, tokens: { ...record.registration!.tokens!, accessToken: 'rotated-oauth', refreshToken: 'rotated-refresh', expiresAt: Date.now() + 3600_000 } }));
  const tokens: (string | null)[] = [];
  http = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); tokens.push(new Headers(init?.headers).get('authorization'));
    if (requests.length === 1) { record.registration!.tokens!.expiresAt = 0; store.write(record); }
    return new Response(new TextEncoder().encode(requests.length === 1 ? toolResponse(root) : textResponse('Found [E1]')));
  };
  jobs.start(null, 'Read the source'); await idle();
  expect(tokens).toEqual(['Bearer fixture-oauth', 'Bearer rotated-oauth']);
  expect(JSON.stringify(db.workspace())).not.toMatch(/rotated-oauth|rotated-refresh/);
  expect(JSON.stringify(requests)).not.toMatch(/rotated-oauth|rotated-refresh/);
});

test('cancellation retains usage already reported by earlier model steps', async () => {
  http = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) return new Response(new TextEncoder().encode(toolResponse(root)));
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error()), { once: true }));
  };
  jobs.start(null, 'Find the answer'); await expect.poll(() => requests.length).toBe(2);
  jobs.cancel(); await idle();
  expect(db.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'cancelled', usage: { input: 10, output: 3, cachedInput: 0 }, usageComplete: false, requests: 2 });
});

test('streamed partial text is retained on Stop but never becomes future model context', async () => {
  http = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(textResponse('Useful partial answer').replace(complete, ''))); } }));
  jobs.start(null, 'Slow answer');
  await expect.poll(() => db.workspace().selected?.messages.at(-1)?.text).toBe('Useful partial answer');
  jobs.cancel(); await idle();
  const conversation = db.workspace().selected!;
  expect(conversation.messages.at(-1)).toMatchObject({ status: 'cancelled', text: expect.stringContaining('Useful partial answer') });
  expect(db.liveContext(conversation.id).history).toEqual([]);
});

test('wall-clock limit cancels a stalled provider without any automatic continuation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  http = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error()), { once: true })); };
  jobs.start(null, 'Slow question');
  await vi.advanceTimersByTimeAsync(1);
  expect(requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(LIVE_LIMITS.milliseconds);
  expect(db.workspace().selected!.messages.at(-1)?.status).toBe('limit');
  expect(workers[0].killed).toBe(true);
  expect(requests).toHaveLength(1);
});

test('a new registration cannot take over an existing conversation', async () => {
  jobs.start(null, 'Hello'); await idle();
  const id = db.workspace().selected!.id;
  const record = store.read()!; record.registration!.subject = 'another-account'; store.write(record);
  expect(() => jobs.start(id, 'Follow up')).toThrow('authorization');
  expect(requests).toHaveLength(1);
  expect(store.read()!.registration!.tokens).toBeDefined();
});

test('disconnect cancels the active worker and cannot activate another model or billing route', async () => {
  http = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error()), { once: true })); };
  jobs.start(null, 'Slow question'); await expect.poll(() => requests.length).toBe(1);
  chatgpt.disconnect(); await idle();
  expect(workers[0].killed).toBe(true);
  expect(db.workspace().selected!.messages.at(-1)?.status).toBe('cancelled');
  expect(requests).toHaveLength(1);
});
