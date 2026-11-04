import { createAssistantMessageEventStream, type AssistantMessage, type Api, type Model, type TranscriptContext, type AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple as completions } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as responses } from '@earendil-works/pi-ai/api/openai-responses';
import { streamSimple as anthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { API_OUTPUT_TOKENS, type ApiGrant } from '../shared/api-models';
import type { StreamObservation } from './chatgpt-stream';
import { checkBeforeModelSend } from '../main/secret-check';
import { transientHttpFailure } from './request-failures';
import { hasUnmanagedProviderContext } from '../shared/provider-context';

const TRANSIENT_API_ERRORS = new Set(['internal_error', 'server_error', 'api_error', 'overloaded_error', 'service_unavailable', 'temporarily_unavailable', 'timeout_error']);

/** API-key transport only. Never chooses credentials, endpoint, route, or another model. */
export function apiStream(model: Model<Api>, context: TranscriptContext, grant: ApiGrant, signal: AbortSignal, allowance: number, observation: StreamObservation, http: typeof fetch = fetch, check: (material: unknown) => void = checkBeforeModelSend): AssistantMessageEventStream {
  const stream = model.api === 'openai-completions' ? completions : model.api === 'openai-responses' ? responses : model.api === 'anthropic-messages' ? anthropic : undefined;
  if (!stream) throw new Error('Unsupported API.');
  const base = new URL(model.baseUrl);
  // Own the deadline through streamed-body consumption, and preserve SDK aborts.
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const safeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const prefix = base.pathname.replace(/\/$/u, '');
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix + '/') || (url.search && !(model.api === 'anthropic-messages' && url.search === '?beta=true')) || url.hash) throw new Error('Endpoint changed.');
    // Inspect the actual serialized SDK body, independently of configuration and onPayload.
    // Fail closed if a future adapter stops supplying a JSON object here.
    if (typeof init?.body !== 'string') throw new Error('Unsupported provider request body.');
    const body: unknown = JSON.parse(init.body);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Unsupported provider request body.');
    if (hasUnmanagedProviderContext(body)) throw new Error('Unmanaged provider-side context is unsupported.');
    const requestSignal = AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]);
    let response: Response;
    try { response = await http(input, { ...init, redirect: 'error', signal: requestSignal }); }
    catch (error) { observation.transient = error instanceof TypeError && !requestSignal.aborted; throw error; }
    observation.transient = transientHttpFailure(response.status, undefined, TRANSIENT_API_ERRORS);
    if (!response.body) return response;
    let size = 0;
    let abort: (() => void) | undefined;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        abort = () => controller.error(new Error('Request cancelled or timed out.'));
        if (requestSignal.aborted) abort();
        else requestSignal.addEventListener('abort', abort, { once: true });
      },
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error('Response exceeded limit.');
        controller.enqueue(chunk);
      },
      flush() { if (abort) requestSignal.removeEventListener('abort', abort); },
    }));
    const metadata = { status: response.status, statusText: response.statusText, headers: response.headers };
    const result = new Response(bounded, metadata);
    if (observation.transient) {
      let text: string;
      try { text = await result.text(); }
      catch (error) { observation.transient = false; throw error; }
      let body: unknown;
      try { body = JSON.parse(text); } catch { /* An unclassified gateway failure may still be transient. */ }
      observation.transient = transientHttpFailure(response.status, body, TRANSIENT_API_ERRORS);
      return new Response(text, metadata);
    }
    return result;
  };
  let terminal = false, anthropicStop = false;
  const raw = stream(model as never, context, {
    apiKey: grant.token, headers: grant.headers, signal: deadline, fetch: safeFetch, maxRetries: 0, timeoutMs: 20_000,
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
      if (['n', 'best_of', 'num_generations', 'num_return_sequences', 'candidate_count'].some(key => body[key] !== undefined && body[key] !== 1)) throw new Error('Multiple paid completions are not permitted.');
      if (body.model !== model.id || typeof cap !== 'number' || cap < 1 || cap > API_OUTPUT_TOKENS) throw new Error('Provider request does not enforce the pinned model and output cap.');
      if (Buffer.byteLength(JSON.stringify(payload)) > Math.min(allowance, model.inputLimits?.maxRequestBytes ?? allowance)) throw new Error('Serialized request exceeded its reserved input allowance.');
      check(payload);
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
