import { normalizeContext } from '@earendil-works/pi-ai';
import { CHATGPT_PROMPT, type ChatGPTResult } from '../shared/chatgpt';
import { chatgptStream, type StreamObservation } from './chatgpt-stream';

/** Fixed connection test, sharing the production conversation adapter but no tools/history. */
export async function chatgptExchange(token: string, model: string, signal: AbortSignal, http: typeof fetch = globalThis.fetch): Promise<ChatGPTResult> {
  const observation: StreamObservation = {};
  const result = await chatgptStream(model, normalizeContext({ messages: [{ role: 'user', content: CHATGPT_PROMPT, timestamp: Date.now() }] }), token, signal, observation, http, 65_536).result();
  return result.stopReason === 'stop'
    ? { status: 'success', ...(observation.usage ? { usage: observation.usage } : {}) }
    : { status: 'failed', reason: observation.failure ?? 'protocol' };
}
