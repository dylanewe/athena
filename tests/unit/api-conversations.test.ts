import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiSettings } from '../../src/main/api-settings';
import { Conversations } from '../../src/main/conversations';
import { Sources } from '../../src/main/sources';
import { LiveSupervisor } from '../../src/main/live-supervisor';
import { Knowledge } from '../../src/main/knowledge';
import type { ChatGPTSettings } from '../../src/main/chatgpt-settings';
import { runLiveAgent } from '../../src/worker/live-agent';
import type { LiveParentMessage, LiveStart } from '../../src/shared/live';
import { FOLDER_CONSENT, type InventorySnapshot } from '../../src/shared/inventory';
import { BUILD_CONSENT } from '../../src/shared/build';

let directory: string, root: string, settings: ApiSettings, conversations: Conversations, sources: Sources, supervisor: LiveSupervisor;
let http: typeof fetch, requests: { url: string; body: Record<string, unknown>; headers: Headers }[], workers: Worker[], reservations: number[];
let scripts: string[];
let knowledge: Knowledge;
let snapshot: InventorySnapshot;
let changed: () => void;
function knowledgeCandidate(claim = 'The answer boundary owns the application answer value.') {
  return { id: 'C1', scope: `folder:${root}`, topic: 'Answer boundary', summary: 'A synchronous answer boundary.', kind: 'responsibility', claim, provenance: 'statically-inferred', perspective: 'current', evidenceIds: ['E1'], relations: [] };
}
const response = (text?: string, tool?: string, args?: unknown) => [
  { choices: [{ index: 0, delta: { role: 'assistant', ...(tool ? { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool, arguments: JSON.stringify(tool === 'retrieve_knowledge' ? { request: args } : args) } }] } : { content: text }) }, finish_reason: null }] },
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
      knowledge: async input => { const r = await this.rpc('knowledge', { input }); if (!r.knowledge) throw new Error(); return r.knowledge; },
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
  changed = () => {};
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-api-live-'))); root = join(directory, 'repo'); mkdirSync(root); writeFileSync(join(root, 'answer.ts'), 'export const answer = 42;\n');
  conversations = new Conversations(join(directory, 'conversations.sqlite'));
  snapshot = { roots: [{ path: root, consent: FOLDER_CONSENT, acceptedAt: 'now', includedLocations: [] }], repositories: [], candidates: [], discovery: { status: 'complete', visited: 0, current: '', nonGitFiles: 1, failures: [] } };
  const inventory = { snapshot: () => snapshot };
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
  knowledge = new Knowledge(join(directory, 'knowledge.sqlite'), sources, inventory, material => conversations.assertClean(material));
  supervisor = new LiveSupervisor(conversations, noOAuth, sources, inventory, () => { const w = new Worker(); workers.push(w); return w; }, () => changed(), settings, knowledge);
});
afterEach(() => { supervisor.cancel(); knowledge.close(); sources.close(); conversations.close(); settings.close(); rmSync(directory, { recursive: true, force: true }); });
async function idle() { await expect.poll(() => conversations.workspace().activeConversationId).toBeNull(); }

function registerBuildRepository() {
  mkdirSync(join(root, '.git'));
  snapshot.repositories.push({ name: 'repo', path: root, presence: 'present', documentationRoots: ['notes'], boundaries: [], fileCount: 1, examined: false });
}

test('explicit builds investigate undocumented code with the shared scheduler and expose persisted coverage and searchable knowledge', async () => {
  registerBuildRepository();
  scripts = [response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 }),
    response(undefined, 'finish_investigation', { findings: [{ claim: 'Value is 42', support: 'source', evidenceIds: ['E1'] }], unresolvedQuestions: ['External callers unknown'], candidateKnowledgeChanges: [], knowledgeCandidates: [{ ...knowledgeCandidate(), scope: 'repo' }] }), response('Architectural overview [E1].')];
  expect(() => supervisor.build(['repo'], 'not consent')).toThrow();
  expect(() => supervisor.build(['missing'], BUILD_CONSENT)).toThrow();
  expect(() => supervisor.build(['repo', 'repo'], BUILD_CONSENT)).toThrow();
  expect(() => supervisor.build(Array(9).fill('repo'), BUILD_CONSENT)).toThrow();
  expect(workers).toHaveLength(0);
  supervisor.build(['repo'], BUILD_CONSENT); await idle();
  const answer = conversations.workspace().selected!.messages.at(-1)!;
  expect(answer).toMatchObject({ status: 'complete', knowledgePublication: 'published', build: { repositories: ['repo'], inspected: [{ operation: 'read', path: 'answer.ts', status: 'complete' }], reusedRepositories: [] }, investigators: [{ scope: 'repo', status: 'complete' }] });
  expect(requests.map(r => r.body.model)).toEqual(['investigator-one', 'investigator-one', 'main-one']);
  expect(JSON.stringify(requests[0].body)).toContain('notes');
  expect((await knowledge.retrieve({ operation: 'search', query: 'Answer boundary', scope: 'repo' })).items).toHaveLength(1);
  conversations.close(); conversations = new Conversations(join(directory, 'conversations.sqlite'));
  expect(conversations.workspace().selected!.messages.at(-1)!.build?.repositories).toEqual(['repo']);
});

test('unchanged builds reuse retained knowledge without paid calls, but edited callers trigger scoped revalidation', async () => {
  registerBuildRepository();
  const finish = response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: ['External callers unknown'], candidateKnowledgeChanges: [], knowledgeCandidates: [{ ...knowledgeCandidate(), scope: 'repo' }] });
  scripts = [response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 }), finish, response('Overview [E1].')];
  supervisor.build(['repo'], BUILD_CONSENT); await idle();
  expect(requests).toHaveLength(3);
  supervisor.build(['repo'], BUILD_CONSENT); await idle();
  expect(requests).toHaveLength(3);
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'complete', requests: 0, build: { reusedRepositories: ['repo'], unresolved: ['repo: External callers unknown'] } });
  writeFileSync(join(root, 'caller.ts'), 'import { answer } from "./answer"; console.log(answer);');
  scripts = [response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 }), finish, response('Revalidated overview [E1].')];
  supervisor.build(['repo'], BUILD_CONSENT); await idle();
  expect(requests).toHaveLength(6);
  expect(JSON.stringify(requests[3].body)).toContain('stale');
  expect(conversations.workspace().selected!.messages.at(-1)?.build?.reusedRepositories).toEqual([]);
  const retained = await knowledge.retrieve({ operation: 'search', query: 'Answer', scope: 'repo' });
  expect(retained.items.some(item => item.freshness === 'current')).toBe(true);
  expect(retained.items.some(item => item.freshness === 'stale')).toBe(true);
});

test.each(['receipt dependency', 'later stale claim'])('refresh does not reuse an unchanged repository when an external %s changed', async mode => {
  registerBuildRepository();
  const other = join(directory, 'other'); mkdirSync(join(other, '.git'), { recursive: true }); writeFileSync(join(other, 'other.ts'), 'export const external = 1;');
  snapshot.roots.push({ path: other, consent: FOLDER_CONSENT, acceptedAt: 'now', includedLocations: [] });
  snapshot.repositories.push({ ...snapshot.repositories[0], name: 'other', path: other });
  const readA = response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 });
  const readB = response(undefined, 'sources_read', { root: other, path: 'other.ts', start: 1, end: 1 });
  const finish = (topic: string) => response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: [], candidateKnowledgeChanges: [], knowledgeCandidates: [{ ...knowledgeCandidate(), topic, scope: 'repo' }] });
  scripts = [...(mode === 'receipt dependency' ? [response(undefined, 'investigate', { question: 'Inspect A only' })] : []), readA, finish('Local boundary'), response('Local overview [E1].')];
  if (mode === 'receipt dependency') supervisor.start(null, 'Inspect A only'); else supervisor.build(['repo'], BUILD_CONSENT);
  await idle();
  scripts = [...(mode === 'later stale claim' ? [response(undefined, 'investigate', { question: 'Inspect A and B' })] : []), readA, readB, finish('Cross-boundary claim'), response('Cross-boundary overview [E1].')];
  if (mode === 'later stale claim') supervisor.start(null, 'Inspect A and B'); else supervisor.build(['repo'], BUILD_CONSENT);
  await idle();
  writeFileSync(join(other, 'other.ts'), 'export const external = 2;');
  const before = requests.length;
  scripts = [readA, readB, finish('Cross-boundary claim'), response('Revalidated overview [E1].')];
  supervisor.build(['repo'], BUILD_CONSENT); await idle();
  expect(requests).toHaveLength(before + 4);
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'complete', build: { reusedRepositories: [] }, investigators: [{ scope: 'repo', status: 'complete' }] });
});

test('mixed documentation layouts report unsupported inputs and unresolved references without requiring a manifest', async () => {
  registerBuildRepository(); mkdirSync(join(root, 'notes')); mkdirSync(join(root, 'odd'));
  writeFileSync(join(root, 'README.md'), 'Start with the notes; old architecture is only intent.');
  writeFileSync(join(root, 'notes', 'architecture.txt'), 'The answer module defines the boundary.');
  writeFileSync(join(root, 'odd', 'decision.rst'), 'An external caller is not available.');
  writeFileSync(join(root, 'diagram.pdf'), '%PDF unsupported');
  const paths = ['README.md', 'notes/architecture.txt', 'odd/decision.rst', 'answer.ts', 'diagram.pdf'];
  scripts = [...paths.map(path => response(undefined, 'sources_read', { root, path, start: 1, end: 1 })),
    response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: ['Missing external caller'], candidateKnowledgeChanges: [], knowledgeCandidates: [{ ...knowledgeCandidate(), scope: 'repo' }] }), response('Mixed layout overview [E1].')];
  supervisor.build(['repo'], BUILD_CONSENT); await idle();
  const report = conversations.workspace().selected!.messages.at(-1)!.build!;
  expect(report.inspected.map(item => item.path)).toEqual(paths);
  expect(report.unsupported).toEqual([expect.objectContaining({ path: 'diagram.pdf', reason: expect.stringMatching(/binary/i) })]);
  expect(report.unresolved).toEqual(['repo: Missing external caller']);
  expect(report.notice).toContain('not exhaustive');
});

test('a truncated build reports partial coverage and withholds candidates rather than extending source limits', async () => {
  registerBuildRepository();
  writeFileSync(join(root, 'many.txt'), 'entry\n'.repeat(201));
  // The first search match reuses E1, keeping this at the existing 200-evidence bound.
  scripts = [response(undefined, 'sources_read', { root, path: 'many.txt', start: 1, end: 1 }), response(undefined, 'sources_search', { root, path: 'many.txt', query: 'entry' }),
    response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: ['Source list truncated'], candidateKnowledgeChanges: [], knowledgeCandidates: [{ ...knowledgeCandidate(), scope: 'repo' }] }), response('Bounded overview [E1].')];
  supervisor.build(['repo'], BUILD_CONSENT); await idle();
  expect(conversations.workspace().selected!.messages.at(-1)!.build?.unsupported).toEqual([expect.objectContaining({ path: 'many.txt', reason: expect.stringContaining('limit') })]);
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'partial', knowledgePublication: 'withheld', build: { truncated: true, failures: [expect.stringContaining('limit')] } });
  expect(requests).toHaveLength(4);
  expect(await knowledge.inspect()).toEqual([]);
});

test('build cancellation stops queued tasks, persists gaps and retry preserves explicit build scope', async () => {
  registerBuildRepository(); conversations.setMaxInvestigators(1);
  const second = join(root, 'second'); mkdirSync(join(second, '.git'), { recursive: true }); writeFileSync(join(second, 'main.ts'), 'export const other = 2;');
  snapshot.repositories.push({ ...snapshot.repositories[0], name: 'second', path: second });
  http = async (_url, init) => {
    requests.push({ url: '', body: JSON.parse(String(init?.body)), headers: new Headers() });
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  supervisor.build(['repo', 'second'], BUILD_CONSENT);
  await expect.poll(() => requests.length).toBe(1);
  supervisor.cancel(); await idle();
  const stopped = conversations.workspace().selected!.messages.at(-1)!;
  expect(stopped).toMatchObject({ status: 'cancelled', build: { repositories: ['repo', 'second'] }, investigators: [{ status: 'cancelled' }, { status: 'cancelled' }] });
  scripts = [response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: ['Uncovered source'], candidateKnowledgeChanges: [] }), response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: ['Uncovered source'], candidateKnowledgeChanges: [] }), response('Partial architectural coverage.')];
  http = async (_url, init) => { requests.push({ url: '', body: JSON.parse(String(init?.body)), headers: new Headers() }); return new Response(scripts.shift()); };
  supervisor.retry(stopped.id); await idle();
  expect(conversations.workspace().selected!.messages.at(-1)!.build?.repositories).toEqual(['repo', 'second']);
  expect(workers.at(-1)?.job?.build?.repositories.map(repo => repo.name)).toEqual(['repo', 'second']);
});

test('builds share the existing fifty-request limit and do not synthesize or publish incomplete work', async () => {
  registerBuildRepository();
  http = async (_url, init) => {
    requests.push({ url: '', body: JSON.parse(String(init?.body)), headers: new Headers() });
    return new Response(response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 }));
  };
  supervisor.build(['repo'], BUILD_CONSENT); await idle();
  expect(requests).toHaveLength(50); expect(reservations).toHaveLength(50);
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'limit', requests: 50, build: { repositories: ['repo'] } });
  expect(await knowledge.inspect()).toEqual([]);
});

test('real Pi agents use separate pinned API-key providers, preserve source boundaries and reserve each request', async () => {
  scripts = [response(undefined, 'investigate', { question: 'Find the answer' }), response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 }),
    response(undefined, 'finish_investigation', { findings: [{ claim: 'Value is 42', support: 'source', evidenceIds: ['E1'] }], unresolvedQuestions: ['Runtime not observed'], candidateKnowledgeChanges: [], knowledgeCandidates: [knowledgeCandidate()] }), response('Value is 42 [E1].')];
  supervisor.start(null, 'Find the answer'); await idle();
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'complete', text: 'Value is 42 [E1].', requests: 4, investigation: { status: 'complete' } });
  expect(requests.map(r => r.body.model)).toEqual(['main-one', 'investigator-one', 'investigator-one', 'main-one']);
  expect(requests.map(r => r.url)).toEqual(['https://main.example/v1/chat/completions', 'https://investigator.example/v1/chat/completions', 'https://investigator.example/v1/chat/completions', 'https://main.example/v1/chat/completions']);
  expect(requests.map(r => r.headers.get('authorization'))).toEqual(['Bearer fake-main-key', 'Bearer fake-investigator-key', 'Bearer fake-investigator-key', 'Bearer fake-main-key']);
  expect(requests.every(r => r.body.max_tokens === 1024)).toBe(true); expect(reservations).toHaveLength(4);
  expect(await knowledge.inspect()).toHaveLength(1);
  expect(conversations.workspace().selected!.messages.at(-1)?.knowledgePublication).toBe('published');
  const binding = conversations.binding(conversations.workspace().selected!.id);
  expect(JSON.stringify(binding)).not.toContain('fake-main-key');
  expect(binding.apiKey?.investigator.model.id).toBe('investigator-one');
});

test('a main-assigned batch runs three investigators concurrently, queues the fourth, and retains assignment order', async () => {
  const releases = new Map<string, () => void>();
  let running = 0, peak = 0;
  http = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), body, headers: new Headers(init?.headers) });
    if (body.model === 'main-one') return new Response(response(requests.length === 1 ? undefined : 'All tasks answered.', requests.length === 1 ? 'investigate' : undefined,
      { tasks: ['A', 'B', 'C', 'D'].map(scope => ({ scope, question: `Inspect ${scope}` })) }));
    const question = JSON.stringify(body.messages);
    const name = ['A', 'B', 'C', 'D'].find(name => question.includes(`Inspect ${name}`))!;
    running++; peak = Math.max(peak, running);
    await new Promise<void>(resolve => releases.set(name, resolve)); running--;
    return new Response(response(undefined, 'finish_investigation', { findings: [{ claim: `Finding ${name}`, support: 'interpretation', evidenceIds: [] }], unresolvedQuestions: [], candidateKnowledgeChanges: [] }));
  };
  supervisor.start(null, 'Compare four boundaries');
  await expect.poll(() => releases.size).toBe(3);
  expect(conversations.workspace().selected?.messages.at(-1)?.investigators?.map(task => task.status)).toEqual(['running', 'running', 'running', 'queued']);
  releases.get('C')!();
  await expect.poll(() => releases.has('D')).toBe(true);
  releases.get('D')!(); releases.get('B')!(); releases.get('A')!();
  await idle();
  const answer = conversations.workspace().selected!.messages.at(-1)!;
  expect(peak).toBe(3);
  expect(answer).toMatchObject({ status: 'complete', requests: 6, usage: { input: 120, output: 30 } });
  expect(answer.investigators?.map(task => [task.scope, task.status, task.result?.findings[0]?.claim])).toEqual(['A', 'B', 'C', 'D'].map(name => [name, 'complete', `Finding ${name}`]));
  expect(reservations).toHaveLength(6);
  expect(JSON.stringify(requests.at(-1)?.body)).not.toContain('sources_read\\\"');
});

test.each([1, 2])('configured concurrency %i is frozen for the job and survives restart', async maximum => {
  conversations.setMaxInvestigators(maximum);
  const releases: (() => void)[] = [];
  let started = 0;
  http = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.model === 'main-one') return new Response(response(undefined, 'investigate', { tasks: ['api', 'worker', 'handoff'].map(scope => ({ scope, question: `Inspect ${scope}` })) }));
    started++;
    await new Promise<void>(resolve => releases.push(resolve));
    return new Response(response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: [], candidateKnowledgeChanges: [] }));
  };
  supervisor.start(null, 'Investigate');
  await expect.poll(() => started).toBe(maximum);
  conversations.setMaxInvestigators(8);
  releases.shift()!();
  await expect.poll(() => started).toBe(maximum + 1);
  expect(conversations.workspace().selected!.messages.at(-1)!.investigators?.filter(task => task.status === 'running')).toHaveLength(maximum);
  supervisor.cancel();
  conversations.close(); conversations = new Conversations(join(directory, 'conversations.sqlite'));
  expect(conversations.maxInvestigators()).toBe(8);
  expect(conversations.workspace().selected!.messages.at(-1)!.investigators?.every(task => !['queued', 'running'].includes(task.status))).toBe(true);
  releases.splice(0).forEach(release => release());
});

test('a failed child leaves an explicit partial answer and publishes successful conflicting candidates without completion-order overwrite', async () => {
  let mainCalls = 0;
  const stages = new Map<string, number>();
  http = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), body, headers: new Headers(init?.headers) });
    if (body.model === 'main-one') return new Response(++mainCalls === 1
      ? response(undefined, 'investigate', { tasks: ['first', 'second', 'denied'].map(scope => ({ scope, question: `Inspect ${scope}` })) })
      : response('Two source-backed interpretations remain in conflict.'));
    const name = ['first', 'second', 'denied'].find(name => JSON.stringify(body.messages).includes(`Inspect ${name}`))!;
    if (name === 'denied') return new Response('{}', { status: 401 });
    const stage = stages.get(name) ?? 0; stages.set(name, stage + 1);
    if (!stage) return new Response(response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 }));
    if (name === 'first') await new Promise(resolve => setTimeout(resolve, 30));
    return new Response(response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: [], candidateKnowledgeChanges: [], knowledgeCandidates: [knowledgeCandidate(name === 'first' ? 'The module owns synchronous answers.' : 'The module owns asynchronous answers.')] }));
  };
  supervisor.start(null, 'Compare interpretations'); await idle();
  const answer = conversations.workspace().selected!.messages.at(-1)!;
  expect(answer).toMatchObject({ status: 'partial', text: expect.stringContaining('Partial: some investigators did not complete'), knowledgePublication: 'published' });
  expect(answer.investigators?.map(task => task.status)).toEqual(['complete', 'complete', 'failed']);
  expect(requests.filter(request => request.body.model === 'investigator-one' && JSON.stringify(request.body).includes('Inspect denied'))).toHaveLength(1);
  const retained = await knowledge.inspect();
  expect(retained).toHaveLength(2);
  expect(retained.map(record => record.claim).sort()).toEqual(['The module owns asynchronous answers.', 'The module owns synchronous answers.']);
  // Semantic conflicts require explicit links; schema validation alone cannot certify them.
  expect(retained.every(record => record.validation === 'unchecked')).toBe(true);
  expect(conversations.liveContext(conversations.workspace().selected!.id).history).toEqual([]);
});

test('invalid delegation shapes do not consume the one main-owned batch', async () => {
  scripts = [response(undefined, 'investigate', {}), response(undefined, 'investigate', { question: 'Ambiguous', tasks: [{ scope: 'API', question: 'Inspect' }] }),
    response(undefined, 'investigate', { tasks: [{ scope: 'API', question: 'Inspect' }] }),
    response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: [], candidateKnowledgeChanges: [] }), response('One valid batch completed.')];
  supervisor.start(null, 'Inspect'); await idle();
  expect(requests.map(request => request.body.model)).toEqual(['main-one', 'main-one', 'main-one', 'investigator-one', 'main-one']);
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'complete', investigators: [{ scope: 'API', status: 'complete' }] });
});

test('mixed publication preserves per-task outcomes and answer navigation metadata across restart', async () => {
  let mainCalls = 0;
  const stages = new Map<string, number>();
  http = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.model === 'main-one') return new Response(++mainCalls === 1 ? response(undefined, 'investigate', { tasks: ['bad', 'good'].map(scope => ({ scope, question: `Inspect ${scope}` })) }) : response('Both inspected [E1].'));
    const name = JSON.stringify(body.messages).includes('Inspect bad') ? 'bad' : 'good';
    const stage = stages.get(name) ?? 0; stages.set(name, stage + 1);
    if (!stage) return new Response(response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 }));
    return new Response(response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: [], candidateKnowledgeChanges: ['A proposal note'], knowledgeCandidates: [{ ...knowledgeCandidate(), relations: name === 'bad' ? [{ kind: 'depends-on', target: 'C999' }] : [] }] }));
  };
  supervisor.start(null, 'Publish what validates'); await idle();
  const answer = conversations.workspace().selected!.messages.at(-1)!;
  expect(answer.knowledgePublication).toBe('partial');
  expect(answer.investigators?.map(task => task.knowledgePublication)).toEqual(['withheld', 'published']);
  expect(await knowledge.inspect()).toHaveLength(1);
  conversations.close(); conversations = new Conversations(join(directory, 'conversations.sqlite'));
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ knowledgePublication: 'partial', investigators: [{ knowledgePublication: 'withheld' }, { knowledgePublication: 'published' }] });
});

test('stop after one transactional publication preserves its records and navigation without publishing the next task', async () => {
  let mainCalls = 0, stopped = false;
  const stages = new Map<string, number>();
  http = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.model === 'main-one') return new Response(++mainCalls === 1 ? response(undefined, 'investigate', { tasks: ['first', 'second'].map(scope => ({ scope, question: `Inspect ${scope}` })) }) : response('Inspected [E1].'));
    const name = JSON.stringify(body.messages).includes('Inspect first') ? 'first' : 'second';
    const stage = stages.get(name) ?? 0; stages.set(name, stage + 1);
    return new Response(!stage ? response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 })
      : response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: [], candidateKnowledgeChanges: [], knowledgeCandidates: [{ ...knowledgeCandidate(), topic: name + ' boundary' }] }));
  };
  changed = () => {
    if (!stopped && conversations.workspace().selected?.messages.at(-1)?.investigators?.[0]?.knowledgePublication === 'published') {
      stopped = true; supervisor.cancel();
    }
  };
  supervisor.start(null, 'Inspect and retain'); await idle();
  expect(stopped).toBe(true);
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'cancelled', knowledgePublication: 'published' });
  expect(conversations.workspace().selected!.messages.at(-1)!.investigators?.map(task => task.knowledgePublication)).toEqual(['published', undefined]);
  expect((await knowledge.inspect()).map(record => record.topic)).toEqual(['first boundary']);
});

test.each(['stop', 'window-close', 'quit', 'revocation'] as const)('%s cancels running and queued tasks, rejects late events and never revives work', async action => {
  const releases: (() => void)[] = [];
  http = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: '', body, headers: new Headers() });
    if (body.model === 'main-one') return new Response(response(undefined, 'investigate', { tasks: ['one', 'two', 'three', 'four', 'five'].map(scope => ({ scope, question: `Inspect ${scope}` })) }));
    await new Promise<void>(resolve => releases.push(resolve));
    return new Response(response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: [], candidateKnowledgeChanges: [] }));
  };
  supervisor.start(null, 'Inspect in parallel');
  await expect.poll(() => releases.length).toBe(3);
  expect(() => supervisor.start(null, 'Do not queue another paid job')).toThrow('already running');
  if (action === 'stop') supervisor.cancel();
  else if (action === 'revocation') { settings.revokeCredential('investigator'); supervisor.revokeApiAuthority(); }
  else supervisor.lifecycle(action);
  await idle();
  const saved = conversations.workspace();
  expect(saved.selected!.messages.at(-1)!.investigators?.map(task => task.status)).toEqual(Array(5).fill('cancelled'));
  releases.splice(0).forEach(release => release());
  workers[0]!.emit('message', { type: 'checkpoint', checkpoint: { investigators: [{ id: 'T1', question: 'late', scope: 'late', status: 'running' }] } });
  workers[0]!.emit('message', { type: 'result', result: { status: 'complete', text: 'late', history: [], requests: 0, usageComplete: true } });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(conversations.workspace()).toEqual(saved);
  expect(requests).toHaveLength(4);
  expect(await knowledge.inspect()).toEqual([]);
});

test('parallel children and retries cannot race past the shared fifty-request limit', async () => {
  http = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ url: '', body, headers: new Headers() });
    if (body.model === 'main-one') return new Response(response(undefined, 'investigate', { tasks: ['one', 'two', 'three', 'four'].map(scope => ({ scope, question: 'Continue bounded reads' })) }));
    if (requests.length % 7 === 0) return new Response('{}', { status: 503 });
    return new Response(response(undefined, 'sources_read', { root, path: 'answer.ts', start: 1, end: 1 }));
  };
  supervisor.start(null, 'Investigate until the shared limit'); await idle();
  expect(requests).toHaveLength(50); expect(reservations).toHaveLength(50);
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'limit', requests: 50 });
  expect(conversations.workspace().selected!.messages.at(-1)!.investigators?.every(task => !['running', 'queued'].includes(task.status))).toBe(true);
});

test('assignments guide relevance without repository permission barriers, private contexts, or nested delegation', async () => {
  writeFileSync(join(root, 'handoff.ts'), 'export const target = "worker";\n');
  let mainCalls = 0;
  const childBodies: string[] = [];
  http = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.model === 'main-one') return new Response(++mainCalls === 1 ? response(undefined, 'investigate', { tasks: [{ scope: 'API-local relevance', question: 'Verify the worker handoff' }] }) : response('Handoff inspected [E1].'));
    childBodies.push(JSON.stringify(body));
    const tools = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(tools).not.toContain('investigate'); expect(tools).not.toContain('set_conversation_title');
    expect(JSON.stringify(body.messages)).not.toContain('PRIVATE_ORIGINAL_QUESTION');
    const stage = childBodies.length;
    return new Response(stage === 1 ? response(undefined, 'investigate', { question: 'Forbidden nested spawn' })
      : stage === 2 ? response(undefined, 'sources_read', { root, path: 'handoff.ts', start: 1, end: 1 })
      : response(undefined, 'finish_investigation', { findings: [{ claim: 'Handoff names worker', support: 'source', evidenceIds: ['E1'] }], unresolvedQuestions: [], candidateKnowledgeChanges: [] }));
  };
  supervisor.start(null, 'PRIVATE_ORIGINAL_QUESTION'); await idle();
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'complete', evidence: [{ citation: { path: 'handoff.ts' } }], investigators: [{ scope: 'API-local relevance', status: 'complete' }] });
  expect(childBodies).toHaveLength(3);
});

test('stopping after one successful task preserves its bounded findings while queued children remain cancelled', async () => {
  conversations.setMaxInvestigators(1);
  let mainCalls = 0, children = 0, release!: () => void;
  http = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.model === 'main-one') return new Response(++mainCalls === 1 ? response(undefined, 'investigate', { tasks: ['success', 'running', 'queued'].map(scope => ({ scope, question: `Inspect ${scope}` })) }) : response('Unexpected'));
    if (++children > 1) await new Promise<void>(resolve => { release = resolve; });
    return new Response(response(undefined, 'finish_investigation', { findings: [{ claim: 'Retained useful finding', support: 'interpretation', evidenceIds: [] }], unresolvedQuestions: [], candidateKnowledgeChanges: [] }));
  };
  supervisor.start(null, 'Inspect');
  await expect.poll(() => children).toBe(2);
  supervisor.cancel(); await idle();
  expect(conversations.workspace().selected!.messages.at(-1)!.investigators).toMatchObject([
    { status: 'complete', result: { findings: [{ claim: 'Retained useful finding' }] } }, { status: 'cancelled' }, { status: 'cancelled' },
  ]);
  release();
});

test.each([401, 403, 429, 503])('HTTP %i retries only transient requests, at most twice, with a reservation for every attempt', async status => {
  http = async (_url, init) => { requests.push({ url: '', body: JSON.parse(String(init?.body)), headers: new Headers() }); return new Response('{}', { status }); };
  supervisor.start(null, 'A bounded request'); await idle();
  expect(requests).toHaveLength(status === 503 ? 3 : 1);
  expect(reservations).toHaveLength(requests.length);
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'failed', requests: requests.length });
});

test.each(['invalid_api_key', 'authentication_error', 'permission_error', 'insufficient_quota', 'rate_limit_exceeded', 'unrecognized_provider_code'])('a transient-looking 503 never retries explicit API-key error %s', async code => {
  http = async (_url, init) => { requests.push({ url: '', body: JSON.parse(String(init?.body)), headers: new Headers() }); return Response.json({ error: { code } }, { status: 503 }); };
  supervisor.start(null, 'A bounded request'); await idle();
  expect(requests).toHaveLength(1); expect(reservations).toHaveLength(1);
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'failed', requests: 1 });
});

test.each([false, true])('API-key pre-response network failures retry at most twice with shared reservations and may recover: %s', async recover => {
  http = async (_url, init) => {
    requests.push({ url: '', body: JSON.parse(String(init?.body)), headers: new Headers() });
    if (!recover || requests.length < 3) throw new TypeError('fetch failed');
    return new Response(response('Network recovered'));
  };
  supervisor.start(null, 'A bounded network request'); await idle();
  expect(requests).toHaveLength(3); expect(reservations).toHaveLength(3);
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: recover ? 'complete' : 'failed', requests: 3, usageComplete: false });
  if (recover) expect(conversations.workspace().selected!.messages.at(-1)!.text).toBe('Network recovered');
});

test('a transient retry can succeed without duplicating tool calls and counts all attempt usage', async () => {
  let calls = 0;
  http = async (_url, init) => { requests.push({ url: '', body: JSON.parse(String(init?.body)), headers: new Headers() }); return ++calls < 3 ? Response.json({ error: { code: 'server_error' } }, { status: 503 }) : new Response(response('Recovered')); };
  supervisor.start(null, 'Recover from temporary outage'); await idle();
  expect(conversations.workspace().selected!.messages.at(-1)).toMatchObject({ status: 'complete', text: 'Recovered', requests: 3, usageComplete: false, usage: { input: 20, output: 5 } });
  expect(reservations).toHaveLength(3);
});

test('indexed reuse stays on the pinned API-key conversation role and reserves each request without an investigator', async () => {
  const result = await sources.run('read', { root, path: 'answer.ts', start: 1, end: 1 });
  const entry = result.entries[0];
  const [id] = await knowledge.publish({ owner: { conversationId: 'prior', messageId: 'prior-answer' }, candidates: [knowledgeCandidate()], evidence: [{ id: 'E1', citation: entry.citation!, text: entry.text! }], completed: true, environmentExposed: false, signal: new AbortController().signal });
  scripts = [response(undefined, 'retrieve_knowledge', { operation: 'search', query: 'answer' }), response(undefined, 'retrieve_knowledge', { operation: 'evidence', id, index: 0 }), response('The source declares 42 [E1]; interpretation remains unchecked.')];
  supervisor.start(null, 'Reuse the indexed answer'); await idle();
  expect(conversations.workspace().selected?.messages.at(-1)).toMatchObject({ status: 'complete', knowledgeReferences: [{ id, topic: 'Answer boundary' }], evidence: [{ id: 'E1' }] });
  expect(requests.map(request => request.body.model)).toEqual(['main-one', 'main-one', 'main-one']);
  expect(reservations).toHaveLength(3);
  expect(requests.every(request => request.url === 'https://main.example/v1/chat/completions')).toBe(true);
});

test('local-only primitive flags do not seal later API-key answers or their pinned follow-ups', async () => {
  writeFileSync(join(root, '.env'), 'FEATURE_ENABLED=false\nRETRIES=1\nFLAG=true\nZERO=0');
  scripts = [response(undefined, 'investigate', { question: 'Inspect configuration' }), response(undefined, 'sources_read', { root, path: '.env' }),
    response(undefined, 'finish_investigation', { findings: [], unresolvedQuestions: ['File withheld'], candidateKnowledgeChanges: [] }), response('File withheld')];
  supervisor.start(null, 'Inspect configuration locally');
  await expect.poll(() => supervisor.environmentPermissions().length).toBe(1);
  const { id } = supervisor.environmentPermissions()[0]; supervisor.environment(id, 'local');
  await expect.poll(() => supervisor.environmentPermissions()[0]?.preview !== undefined).toBe(true);
  supervisor.environment(id, 'deny'); await idle();
  expect(conversations.workspace().selected?.sealed).not.toBe(true);
  scripts = [response('Ordinary answer'), response('Ordinary follow-up')];
  supervisor.start(null, 'An unrelated question'); await idle();
  const conversation = conversations.workspace().selected!;
  expect(conversation.sealed).not.toBe(true);
  supervisor.start(conversation.id, 'An unrelated follow-up'); await idle();
  expect(conversations.workspace().selected?.sealed).not.toBe(true);
  expect(conversations.workspace().selected?.messages.at(-1)).toMatchObject({ status: 'complete', text: 'Ordinary follow-up' });
});

test('API-key outbound environment approval propagates across separately pinned roles without persisting echoes or bypassing reservations', async () => {
  const canary = 'synthetic-api-environment-7';
  writeFileSync(join(root, '.env'), 'PASSWORD=' + canary);
  scripts = [response(undefined, 'investigate', { question: 'Read configuration' }), response(undefined, 'sources_read', { root, path: '.env' }),
    response(undefined, 'finish_investigation', { findings: [{ claim: 'PASSWORD=' + canary, support: 'source', evidenceIds: ['E1'] }], unresolvedQuestions: [], candidateKnowledgeChanges: [], knowledgeCandidates: [knowledgeCandidate(canary)] }), response('PASSWORD=' + canary)];
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
  expect(await knowledge.inspect()).toEqual([]);
  expect(readdirSync(directory).filter(file => file.startsWith('knowledge.sqlite')).some(file => readFileSync(join(directory, file)).includes(canary))).toBe(false);
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
