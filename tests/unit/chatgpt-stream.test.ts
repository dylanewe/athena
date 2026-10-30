import { expect, test } from 'vitest';
import { normalizeContext, type Model } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-responses';
import { chatgptStream } from '../../src/worker/chatgpt-stream';

const model: Model<'openai-responses'> = { id: 'fixture-model', name: 'Fixture', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', reasoning: false, input: ['text'], contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context = normalizeContext({ messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] });
export const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
export const completed = frame({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } } });

test('installed Pi Responses adapter accepts headerless SSE and sends an explicit OAuth bearer without API-key discovery', async () => {
  let requests = 0;
  const result = await stream(model, normalizeContext({ messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] }), {
    apiKey: 'fixture-oauth', maxRetries: 0, cacheRetention: 'none', env: {},
    fetch: async (url, options) => {
      requests++;
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer fixture-oauth');
      const response = new Response(new TextEncoder().encode(completed));
      expect(response.headers.has('content-type')).toBe(false);
      return response;
    },
  }).result();
  expect(result.stopReason).toBe('stop');
  expect(requests).toBe(1);
});

test.each([undefined, 'text/event-stream'])('Athena wrapper accepts completed streams with header %s and only subscription fields', async contentType => {
  const result = await chatgptStream('fixture-model', context, 'fixture-oauth', new AbortController().signal, {}, async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    expect(Object.keys(body).sort()).toEqual(['include', 'input', 'model', 'store', 'stream']);
    expect(body).toMatchObject({ store: false, stream: true });
    expect(options?.redirect).toBe('error');
    return new Response(new TextEncoder().encode(completed), { headers: contentType ? { 'content-type': contentType } : {} });
  }).result();
  expect(result.stopReason).toBe('stop');
});

test.each([
  ['', undefined], [completed, 'application/json'],
  [frame({ type: 'response.completed', response: { status: 'queued' } }), undefined],
  [frame({ type: 'response.completed', response: {} }), undefined],
  [frame({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }), undefined],
  [frame({ type: 'response.failed', response: { status: 'failed' } }), undefined],
  ['data: [DONE]\n\n', undefined],
])('Athena rejects false successful completion: %s', async (body, contentType) => {
  const result = await chatgptStream('fixture-model', context, 'fixture-oauth', new AbortController().signal, {}, async () =>
    new Response(new TextEncoder().encode(body), { headers: contentType ? { 'content-type': contentType } : {} })).result();
  expect(result.stopReason).toBe('error');
});
