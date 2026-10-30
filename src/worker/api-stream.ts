import { createAssistantMessageEventStream, type AssistantMessage, type Api, type Model, type TranscriptContext, type AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple as completions } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as responses } from '@earendil-works/pi-ai/api/openai-responses';
import { streamSimple as anthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { API_OUTPUT_TOKENS, type ApiGrant } from '../shared/api-models';
import type { StreamObservation } from './chatgpt-stream';
import { checkBeforeModelSend } from '../main/secret-check';

/** API-key transport only. Never chooses credentials, endpoint, route, or another model. */
export function apiStream(model: Model<Api>, context: TranscriptContext, grant: ApiGrant, signal: AbortSignal, allowance: number, observation: StreamObservation, http: typeof fetch = fetch): AssistantMessageEventStream {
  const stream = model.api === 'openai-completions' ? completions : model.api === 'openai-responses' ? responses : model.api === 'anthropic-messages' ? anthropic : undefined;
  if (!stream) throw new Error('Unsupported API.');
  const base = new URL(model.baseUrl);
  const safeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const prefix = base.pathname.replace(/\/$/u, '');
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix + '/') || (url.search && !(model.api === 'anthropic-messages' && url.search === '?beta=true')) || url.hash) throw new Error('Endpoint changed.');
    const response = await http(input, { ...init, redirect: 'error', signal });
    if (!response.body) return response;
    let size = 0;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error('Response exceeded limit.');
      controller.enqueue(chunk);
    } }));
    return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  let terminal = false, anthropicStop = false;
  const raw = stream(model as never, context, {
    apiKey: grant.token, headers: grant.headers, signal, fetch: safeFetch, maxRetries: 0, timeoutMs: 20_000,
    maxTokens: API_OUTPUT_TOKENS, reasoning: undefined, cacheRetention: 'none', transport: 'sse',
    onProviderStreamEvent(event) {
      type Usage = { input_tokens: number; output_tokens: number; prompt_tokens: number; completion_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; input_tokens_details?: { cached_tokens?: number } };
      const e = event as { type?: string; choices?: { finish_reason?: string }[]; delta?: { stop_reason?: string }; usage?: Usage; response?: { status?: string; usage?: Usage }; message?: { usage?: Usage } };
      if (model.api === 'openai-completions' && e.choices?.some(c => ['stop', 'tool_calls', 'function_call'].includes(c.finish_reason ?? ''))) terminal = true;
      if (model.api === 'openai-responses' && e.type === 'response.completed' && e.response?.status === 'completed') terminal = true;
      if (e.type === 'message_delta' && ['end_turn', 'tool_use', 'stop_sequence'].includes(e.delta?.stop_reason ?? '')) anthropicStop = true;
      if (model.api === 'anthropic-messages' && e.type === 'message_stop' && anthropicStop) terminal = true;
      const counts = (input: unknown, output: unknown, cachedInput: unknown = 0) => {
        if ([input, output, cachedInput].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) observation.usage = { input: Number(input), output: Number(output), cachedInput: Number(cachedInput) };
      };
      if (model.api === 'openai-completions' && e.usage) counts(e.usage.prompt_tokens, e.usage.completion_tokens, e.usage.prompt_tokens_details?.cached_tokens ?? 0);
      if (model.api === 'openai-responses' && e.type === 'response.completed' && e.response?.usage) counts(e.response.usage.input_tokens, e.response.usage.output_tokens, e.response.usage.input_tokens_details?.cached_tokens ?? 0);
      if (model.api === 'anthropic-messages' && e.type === 'message_start' && e.message?.usage) {
        const u = e.message.usage;
        counts(u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), u.output_tokens, u.cache_read_input_tokens ?? 0);
      }
      if (model.api === 'anthropic-messages' && e.type === 'message_delta' && observation.usage) counts(observation.usage.input, e.usage?.output_tokens, observation.usage.cachedInput);
    },
    onPayload(payload) {
      const body = payload as Record<string, unknown>;
      const cap = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
      if (body.model !== model.id || typeof cap !== 'number' || cap < 1 || cap > API_OUTPUT_TOKENS) throw new Error('Provider request does not enforce the pinned model and output cap.');
      if (Buffer.byteLength(JSON.stringify(payload)) > Math.min(allowance, model.inputLimits?.maxRequestBytes ?? allowance)) throw new Error('Serialized request exceeded its reserved input allowance.');
      checkBeforeModelSend(payload);
      return payload;
    },
  });
  const output = createAssistantMessageEventStream();
  const failure = (message?: AssistantMessage): AssistantMessage => ({
    ...(message ?? { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
    content: [], stopReason: signal.aborted ? 'aborted' : 'error', errorMessage: 'API-key request failed or returned an incomplete response. Retry explicitly; no fallback was used.',
  });
  void (async () => {
    for await (const event of raw) {
      if (event.type === 'error' || (event.type === 'done' && (!terminal || !['stop', 'toolUse'].includes(event.message.stopReason)))) {
        observation.failure = 'unavailable';
        const error = failure(event.type === 'error' ? event.error : event.message);
        output.push({ type: 'error', reason: error.stopReason as 'error' | 'aborted', error });
      } else output.push(event);
    }
    // If an adapter ends without a terminal event, never leave Agent waiting or accept tools.
    output.push({ type: 'error', reason: 'error', error: failure() }); output.end();
  })().catch(() => {
    observation.failure = 'unavailable';
    output.push({ type: 'error', reason: 'error', error: failure() }); output.end();
  });
  return output;
}
