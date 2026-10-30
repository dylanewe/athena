import { expect, test, vi } from 'vitest';
import { normalizeContext, type Api, type Model } from '@earendil-works/pi-ai';
import { apiStream } from '../../src/worker/api-stream';
import type { StreamObservation } from '../../src/worker/chatgpt-stream';
const context = normalizeContext({ messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] });
const signal = () => new AbortController().signal;
const frame = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
function model(api: Api): Model<Api> { return { id: 'fixture', name: 'Fixture', api, provider: 'fake', baseUrl: 'https://fake.example/v1', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, ...(api === 'openai-completions' ? { compat: { maxTokensField: 'max_tokens' as const } } : {}) }; }
const responses = frame({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 4 } } });
const completions = frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } }) + 'data: [DONE]\n\n';
const anthropic = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'fixture', usage: { input_tokens: 12, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }, { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
].map(e => `event: ${e.type}\n${frame(e)}`).join('');
test.each([['openai-completions', completions, 'max_tokens'], ['openai-responses', responses, 'max_output_tokens'], ['anthropic-messages', anthropic, 'max_tokens']])('installed %s adapter enforces output cap, no retries/redirects, explicit auth, and observed usage', async (api, sse, cap) => {
  const observation: StreamObservation = {}; let calls = 0;
  const result = await apiStream(model(api), context, { token: 'fake-request-key', headers: {} }, signal(), 64000, observation, async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    expect(body[cap]).toBe(1024); expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get(api === 'anthropic-messages' ? 'x-api-key' : 'authorization')).toBe(api === 'anthropic-messages' ? 'fake-request-key' : 'Bearer fake-request-key');
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  }).result();
  expect(result.stopReason).toBe('stop'); expect(observation.usage).toEqual({ input: 12, output: 4, cachedInput: 0 }); expect(calls).toBe(1);
});
test.each([
  ['openai-completions', frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'unfinished' } }] })],
  ['openai-responses', frame({ type: 'response.completed', response: { status: 'queued' } })],
  ['openai-responses', frame({ type: 'response.incomplete', response: { status: 'incomplete' } })],
  ['anthropic-messages', anthropic.replace(/event: message_stop[\s\S]*$/u, '')],
])('rejects incomplete %s streams instead of accepting tools or success', async (api, sse) => {
  const result = await apiStream(model(api), context, { token: 'fake', headers: {} }, signal(), 64000, {}, async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } })).result();
  expect(result.stopReason).toBe('error');
});
test.each(['headers', 'body'])('owns the 20-second request deadline through stalled %s without discarding SDK cancellation', async phase => {
  const original = AbortSignal.timeout;
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => original(ms === 20_000 ? 10 : ms));
  const parent = new AbortController();
  let forwarded: AbortSignal | undefined;
  try {
    const result = await apiStream(model('openai-completions'), context, { token: 'fake', headers: {} }, parent.signal, 64000, {}, async (_url, init) => {
      forwarded = init?.signal ?? undefined;
      if (phase === 'headers') return new Promise<Response>((_resolve, reject) => forwarded!.addEventListener('abort', () => reject(new Error('private timeout error')), { once: true }));
      return new Response(new ReadableStream<Uint8Array>(), { headers: { 'content-type': 'text/event-stream' } });
    }).result();
    expect(result.stopReason).toBe('error'); expect(parent.signal.aborted).toBe(false); expect(forwarded?.aborted).toBe(true); expect(forwarded).not.toBe(parent.signal);
    expect(timeout).toHaveBeenCalledWith(20_000);
  } finally { timeout.mockRestore(); }
});
test('no fabricated zero usage; payload overflow and provider errors are redacted without retries', async () => {
  const observation: StreamObservation = {};
  await apiStream(model('openai-completions'), context, { token: 'fake', headers: {} }, signal(), 64000, observation, async () => new Response(completions.replace(',"usage":{"prompt_tokens":12,"completion_tokens":4}', ''), { headers: { 'content-type': 'text/event-stream' } })).result();
  expect(observation.usage).toBeUndefined();
  let calls = 0;
  const failed = await apiStream(model('openai-completions'), context, { token: 'fake', headers: {} }, signal(), 64000, {}, async () => { calls++; return new Response('sensitive-raw-provider-error', { status: 401 }); }).result();
  expect(calls).toBe(1); expect(failed.errorMessage).not.toContain('sensitive-raw-provider-error');
  const overflow = await apiStream(model('openai-completions'), context, { token: 'fake', headers: {} }, signal(), 1, {}, async () => { throw new Error('HTTP must not be called'); }).result();
  expect(overflow.stopReason).toBe('error');
  let multiplicitySent = false;
  const multiple = await apiStream({ ...model('openai-completions'), samplingParams: { n: 20 } }, context, { token: 'fake', headers: {} }, signal(), 64000, {}, async () => { multiplicitySent = true; return new Response(completions); }).result();
  expect(multiple.stopReason).toBe('error'); expect(multiplicitySent).toBe(false);
});
