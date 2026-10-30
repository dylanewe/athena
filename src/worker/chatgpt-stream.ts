import { createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage, type Model, type TranscriptContext } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-responses';
import { bearer, readJSON, RESOURCE, responseFailure } from '../main/chatgpt-protocol';
import { CHATGPT_ERRORS, parseChatGPTUsage, type ChatGPTFailure, type ChatGPTUsage } from '../shared/chatgpt';
import { checkBeforeModelSend } from '../main/secret-check';

// Catalog supplies identity, not trustworthy limits/prices. Zero metadata here is
// an adapter placeholder, never a displayed price, usage count, or token limit.
export function chatgptModel(id: string): Model<'openai-responses'> {
  return { id, name: id, provider: 'openai', api: 'openai-responses', baseUrl: RESOURCE,
    reasoning: false, input: ['text'], contextWindow: 0, maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
export interface StreamObservation { usage?: ChatGPTUsage; failure?: ChatGPTFailure }

/** Direct Pi wire adapter only: no provider registry, ambient auth, or OAuth ownership. */
export function chatgptStream(model: string, context: TranscriptContext, token: string, signal: AbortSignal,
  observation: StreamObservation = {}, http: typeof fetch = globalThis.fetch, eventLimit = 512 * 1024): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    let sent = false, completed = false;
    let partial: AssistantMessage | undefined;
    const fail = (reason: ChatGPTFailure): never => { observation.failure = reason; throw new Error(CHATGPT_ERRORS[reason]); };
    try {
      if (!bearer(token) || !model || model.length > 256 || /[\s\x00-\x1f\x7f]/u.test(model)) fail('protocol');
      signal.throwIfAborted();
      const upstream = stream(chatgptModel(model), context, {
        apiKey: token, signal, maxRetries: 0, timeoutMs: 15 * 60_000, cacheRetention: 'none', env: {},
        identity: { userAgent: { custom: 'Athena/0.1' }, attribution: null },
        onPayload: payload => {
          const p = payload as Record<string, unknown>;
          // Construct a subscription allowlist, rather than depending on Pi's token heuristics.
          return { model, input: p.input, ...(p.tools ? { tools: p.tools } : {}), store: false, stream: true,
            include: ['reasoning.encrypted_content'] };
        },
        fetch: async (url, options) => {
          signal.throwIfAborted();
          if (sent || String(url) !== `${RESOURCE}/responses` || options?.method !== 'POST' || typeof options.body !== 'string') return fail('protocol');
          if (Buffer.byteLength(options.body) > 2 * 1024 * 1024) return fail('context');
          checkBeforeModelSend(options.body);
          sent = true;
          const response = await http(url, { ...options, redirect: 'error' });
          if (!response.ok) {
            let body = {};
            try { body = await readJSON(response); } catch { /* Only application-authored errors escape. */ }
            return fail(responseFailure(response.status, body));
          }
          const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
          if ((mediaType && mediaType !== 'text/event-stream') || !response.body) {
            void response.body?.cancel().catch(() => {}); return fail('protocol');
          }
          // Bounds apply before SDK parsing, including headerless and non-SSE bodies.
          let bytes = 0, eventBytes = 0, previousLF = false;
          const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > 8 * 1024 * 1024) return fail('protocol');
              for (const byte of chunk) {
                if (++eventBytes > eventLimit) return fail('protocol');
                if (byte === 13) continue;
                if (byte === 10 && previousLF) eventBytes = 0;
                previousLF = byte === 10;
              }
              controller.enqueue(chunk);
            },
          }), { signal });
          return new Response(bounded, { status: response.status, headers: response.headers });
        },
        onProviderStreamEvent: raw => {
          const event = raw as { type?: string; response?: { status?: string; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } };
          if (event.type === 'response.failed' || event.type === 'error') fail(responseFailure(400, event.type === 'error' ? { error: event } : event.response ?? {}));
          if (event.type === 'response.incomplete') fail('protocol');
          if (event.type === 'response.completed') {
            if (completed || event.response?.status !== 'completed') fail('protocol');
            completed = true;
            const u = event.response?.usage;
            observation.usage = u ? parseChatGPTUsage({ input: u.input_tokens, output: u.output_tokens, cachedInput: u.input_tokens_details?.cached_tokens ?? 0 }) : undefined;
          }
        },
      });
      for await (const event of upstream) {
        if (event.type === 'error') { partial = event.error; fail(observation.failure ?? 'protocol'); }
        if (event.type === 'done') {
          partial = event.message;
          if (!completed || signal.aborted || !['stop', 'toolUse'].includes(event.reason)) fail(signal.aborted ? 'cancelled' : 'protocol');
          output.push(event); output.end(); return;
        }
        if ('partial' in event) partial = event.partial;
        output.push(event);
      }
      fail('protocol');
    } catch {
      const reason = signal.aborted ? 'cancelled' : observation.failure ?? 'unavailable';
      observation.failure = reason;
      const error: AssistantMessage = { ...(partial ?? { role: 'assistant', content: [], api: 'openai-responses', provider: 'openai', model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() }),
        stopReason: signal.aborted ? 'aborted' : 'error', errorMessage: CHATGPT_ERRORS[reason] };
      output.push({ type: 'error', reason: error.stopReason as 'error' | 'aborted', error }); output.end();
    }
  })();
  return output;
}
