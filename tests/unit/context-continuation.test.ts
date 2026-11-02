import { expect, test } from 'vitest';
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { runLiveAgent } from '../../src/worker/live-agent';
import type { LiveCapabilities } from '../../src/worker/live-agent';
import type { LiveStart } from '../../src/shared/live';

const model: Model<'openai-completions'> = { id: 'bounded', name: 'Bounded', api: 'openai-completions', provider: 'test', baseUrl: 'https://approved.example/v1', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1024, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
function assistant(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function response(text: string) {
  return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
}
function job(history: Message[] = []): LiveStart {
  const pinned = { model, headerRefs: {}, authHeader: false };
  return { apiKey: { conversation: pinned, investigator: pinned }, model: model.id, prompt: 'Continue, preserve the open question.', roots: [], history };
}
const capabilities = (activities: string[], grants: number[]): LiveCapabilities => ({ access: async () => { throw new Error('No fallback'); }, apiAccess: async (_role, bytes) => { grants.push(bytes); return { token: 'fake', headers: {} }; }, source: async () => { throw new Error('No source'); }, progress: (_text, activity) => activities.push(activity) });

test('long histories compact under the pinned capacity, preserving exact constraints and evidence references without source digests', async () => {
  const activities: string[] = [], grants: number[] = [], payloads: string[] = [];
  const history: Message[] = [{ role: 'user', content: 'Never execute code. Scope: payments. Open question: retry ownership?', timestamp: 1 }];
  for (let i = 0; i < 18; i++) history.push(assistant(`Uncertain interpretation [E1]. ${'older discussion '.repeat(350)}`));
  const result = await runLiveAgent(job(history), capabilities(activities, grants), new AbortController().signal, async (_url, init) => {
    payloads.push(String(init?.body));
    return response(String(init?.body).includes('Compact continuation notes') ? 'Retry ownership remains unresolved.' : 'Continuation is uncertain; reinspect retained evidence.');
  });
  expect(result.status).toBe('complete');
  expect(result.requests).toBeGreaterThan(1);
  expect(grants).toHaveLength(result.requests);
  expect(grants.every(bytes => bytes <= 58880)).toBe(true);
  expect(payloads.at(-1)).toContain('Never execute code. Scope: payments. Open question: retry ownership?');
  expect(payloads.at(-1)).toContain('E1');
  expect(JSON.stringify(result.history).length).toBeLessThan(60000);
  expect(result.history.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text.includes('"references":["E1"]')))).toBe(true);
  expect(activities.join(' ')).toContain('Compact');
});

test.each(['error', 'empty', 'oversized', 'cancel', 'budget'] as const)('unsafe summary %s stops with an explicit narrower partial result and no continuation call', async failure => {
  const controller = new AbortController(), activities: string[] = [], grants: number[] = [];
  const history = Array.from({ length: 18 }, () => assistant('older discussion '.repeat(350)));
  let calls = 0;
  const authority = capabilities(activities, grants);
  if (failure === 'budget') authority.apiAccess = async () => { throw new Error('No remaining approved budget'); };
  const result = await runLiveAgent(job(history), authority, controller.signal, async () => {
    calls++;
    if (failure === 'cancel') controller.abort();
    if (failure === 'error') return new Response('provider detail must not persist', { status: 400 });
    return response(failure === 'oversized' ? 'x'.repeat(9000) : '');
  });
  expect(result.status).toBe(failure === 'cancel' ? 'cancelled' : 'partial');
  expect(result.requests).toBe(1);
  expect(calls).toBe(failure === 'budget' ? 0 : 1);
  expect(result.history).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('provider detail');
  if (failure !== 'cancel') expect(result.text).toContain('Narrow follow-up');
});

test('transient summary retries reserve fresh authority on the same pinned provider and contribute to total usage', async () => {
  const grants: number[] = [], urls: string[] = [];
  let retries = 0;
  const result = await runLiveAgent(job(Array.from({ length: 18 }, () => assistant('older discussion '.repeat(350)))), capabilities([], grants), new AbortController().signal, async (url, init) => {
    urls.push(String(url));
    if (String(init?.body).includes('Compact continuation notes') && retries++ < 2) return new Response('{}', { status: 503 });
    return response('Unresolved; recheck sources.');
  });
  expect(result.status).toBe('complete');
  expect(grants).toHaveLength(result.requests);
  expect(result.requests).toBeGreaterThanOrEqual(4);
  expect(urls.every(url => url === 'https://approved.example/v1/chat/completions')).toBe(true);
  expect(result.usage!.input).toBe((result.requests - 2) * 10);
  expect(result.usageComplete).toBe(false); // Failed attempts retain their reservations, not invented usage.
});

test('summary requests and later tool steps share the fifty-request limit without an extra allowance', async () => {
  const grants: number[] = [];
  let summaries = 0, calls = 0;
  const result = await runLiveAgent(job(Array.from({ length: 18 }, () => assistant('older discussion '.repeat(350)))), capabilities([], grants), new AbortController().signal, async (_url, init) => {
    calls++;
    if (String(init?.body).includes('Compact continuation notes')) { summaries++; return response('Unresolved; recheck sources.'); }
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${calls}`, type: 'function', function: { name: 'retrieve_knowledge', arguments: JSON.stringify({ request: { operation: 'search', query: 'pending' } }) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
  });
  expect(summaries).toBeGreaterThan(0);
  expect(result.status).toBe('limit');
  expect(result.requests).toBe(50);
  expect(grants).toHaveLength(50);
  expect(calls).toBe(50);
});

test('an oversized individual user constraint is not silently summarized or sent', async () => {
  const grants: number[] = [];
  const result = await runLiveAgent({ ...job(), prompt: 'x'.repeat(100000) }, capabilities([], grants), new AbortController().signal, async () => { throw new Error('must not send'); });
  expect(result.status).toBe('partial');
  expect(result.text).toContain('Narrow follow-up');
  expect(grants).toEqual([]);
});
