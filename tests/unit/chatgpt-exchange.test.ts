import { expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chatgptExchange } from '../../src/worker/chatgpt-exchange';
import { ChatGPTProcess, type ChatGPTWorker } from '../../src/main/chatgpt-process';
import { CHATGPT_PROMPT } from '../../src/shared/chatgpt';

const event = (type: string, response?: unknown) => `data: ${JSON.stringify({ type, response })}\n\n`;
const complete = event('response.completed', { status: 'completed', usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } });
const run = (body: string) => chatgptExchange('oauth-token', 'catalog-model', new AbortController().signal, async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));

test('sends precisely the fixed request and accepts only completed SSE with numeric usage', async () => {
  const result = await chatgptExchange('oauth-token', 'catalog-model', new AbortController().signal, async (url, init) => {
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oauth-token');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'catalog-model', store: false, stream: true, include: ['reasoning.encrypted_content'], input: [{ role: 'user', content: [{ type: 'input_text', text: CHATGPT_PROMPT }] }] });
    return new Response(event('response.created', { status: 'in_progress' }) + complete, { headers: { 'content-type': 'text/event-stream' } });
  });
  expect(result).toEqual({ status: 'success', usage: { input: 12, output: 4, cachedInput: 2 } });
});

test('accepts a completed SSE response when the live route omits Content-Type', async () => {
  // Byte bodies avoid Response's automatic text/plain header for string bodies.
  const response = new Response(new TextEncoder().encode(complete));
  expect(response.headers.get('content-type')).toBeNull();
  expect(await chatgptExchange('oauth-token', 'model', new AbortController().signal, async () => response))
    .toEqual({ status: 'success', usage: { input: 12, output: 4, cachedInput: 2 } });
});

test.each([null, '', '{"status":"completed"}', event('response.output_text.delta', {}), event('response.incomplete', { status: 'incomplete' })])('missing Content-Type still requires a complete SSE body: %j', async body => {
  const response = new Response(body === null ? null : new TextEncoder().encode(body));
  expect((await chatgptExchange('oauth-token', 'model', new AbortController().signal, async () => response)).status).toBe('failed');
});

test.each(['text/html', 'application/json', 'text/event-streaming'])('rejects an explicitly incompatible media type: %s', async contentType => {
  const response = new Response(complete, { headers: { 'content-type': contentType } });
  expect((await chatgptExchange('oauth-token', 'model', new AbortController().signal, async () => response)).status).toBe('failed');
});

test('handles UTF-8 and CRLF split across chunks without treating text deltas as success', async () => {
  const bytes = new TextEncoder().encode((event('response.output_text.delta', { delta: 'héllo' }) + complete).replaceAll('\n', '\r\n'));
  const result = await chatgptExchange('oauth-token', 'model', new AbortController().signal, async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }));
  expect(result.status).toBe('success');
});

test.each([
  '', 'data: [DONE]\n\n', event('response.output_text.delta', { delta: 'OK' }),
  event('response.incomplete', { status: 'incomplete' }), event('response.completed', { status: 'failed' }),
  event('response.failed', { status: 'failed', error: { code: 'server_error', message: 'secret' } }),
  'data: malformed\n\n', `data: ${'x'.repeat(70_000)}\n\n`,
])('incomplete, interrupted, failed or oversized stream is never successful', async body => { expect((await run(body)).status).toBe('failed'); });

test('quota failure can arrive after streaming begins', async () => {
  expect(await run(event('response.output_text.delta', {}) + event('response.failed', { error: { code: 'subscription_sharing_usage_limit_exceeded' } }))).toEqual({ status: 'failed', reason: 'quota' });
});

test.each([undefined, {}, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 6 } }])('successful completion with missing/invalid usage does not invent usage: %j', async usage => {
  expect(await run(event('response.completed', { status: 'completed', usage }))).toEqual({ status: 'success' });
});

test.each([[401, 'authentication'], [403, 'ineligible'], [429, 'quota'], [503, 'unavailable']] as const)('HTTP %s produces safe actionable result without retries', async (status, reason) => {
  const http = vi.fn(async () => new Response('raw private-token', { status }));
  expect(await chatgptExchange('oauth-token', 'model', new AbortController().signal, http)).toEqual({ status: 'failed', reason });
  expect(http).toHaveBeenCalledOnce();
});

test('API keys are rejected before a request is sent', async () => {
  const http = vi.fn();
  expect(await chatgptExchange('sk-api-key', 'model', new AbortController().signal, http)).toEqual({ status: 'failed', reason: 'protocol' });
  expect(http).not.toHaveBeenCalled();
});

class Worker extends EventEmitter {
  messages: unknown[] = [];
  kills = 0;
  postMessage(value: unknown) { this.messages.push(value); }
  kill() { this.kills++; return true; }
}
test('supervisor sends only token/model, sanitizes results, and kills completed or cancelled workers including late spawn', async () => {
  const worker = new Worker();
  const process = new ChatGPTProcess(() => worker as ChatGPTWorker);
  const request = process.start('token', 'model');
  expect(worker.messages).toEqual([{ token: 'token', model: 'model' }]);
  worker.emit('message', { status: 'success', usage: { input: 1, output: 1, cachedInput: 0 }, accessToken: 'secret', text: 'raw-provider-text' });
  expect(await request.result).toEqual({ status: 'success', usage: { input: 1, output: 1, cachedInput: 0 } });
  expect(worker.kills).toBe(1);
  const second = new Worker(); const pending = new ChatGPTProcess(() => second).start('token', 'model');
  pending.cancel(); second.emit('spawn'); second.emit('message', { status: 'success' });
  expect(await pending.result).toEqual({ status: 'failed', reason: 'cancelled' }); expect(second.kills).toBe(2);
});

test('worker crash, malformed message, and spawn failure fail closed', async () => {
  const worker = new Worker(); const pending = new ChatGPTProcess(() => worker).start('token', 'model');
  worker.emit('exit'); expect((await pending.result).status).toBe('failed');
  const second = new Worker(); const malformed = new ChatGPTProcess(() => second).start('token', 'model');
  second.emit('message', { status: 'failed', reason: 'private-token' });
  expect(await malformed.result).toEqual({ status: 'failed', reason: 'protocol' });
  expect((await new ChatGPTProcess(() => { throw new Error('secret'); }).start('token', 'model').result).status).toBe('failed');
});
