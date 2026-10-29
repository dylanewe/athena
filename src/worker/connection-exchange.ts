import { normalizeContext } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { DEEPSEEK_MODEL } from '../main/deepseek-model';
import { CONNECTION_MAX_TOKENS, CONNECTION_PROMPT, CONNECTION_TIMEOUT_MS, parseTokenUsage } from '../shared/models';
import type { ConnectionResult } from '../main/model-settings';

function hasReportedUsage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  const usage = parseTokenUsage({
    input: raw.prompt_tokens, output: raw.completion_tokens,
    cacheRead: details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens ?? 0,
    cacheWrite: details?.cache_write_tokens ?? 0,
  });
  return !!usage && usage.cacheRead + usage.cacheWrite <= usage.input;
}

/** Direct Pi API bypasses credential discovery; only this fixed context can be sent. */
export async function exchange(key: string, signal: AbortSignal, fetchRequest: typeof fetch = globalThis.fetch): Promise<ConnectionResult> {
  let status = 0;
  let sent = false;
  let reportedUsage = false;
  let sawUsage = false;
  const failure = (): ConnectionResult => ({ status: 'failed', reason: status === 401 || status === 403 ? 'authentication' : 'provider' });
  try {
    const response = await stream(DEEPSEEK_MODEL, normalizeContext({
      messages: [{ role: 'user', content: CONNECTION_PROMPT, timestamp: Date.now() }],
    }), {
      apiKey: key, signal, maxTokens: CONNECTION_MAX_TOKENS, timeoutMs: CONNECTION_TIMEOUT_MS,
      maxRetries: 0, cacheRetention: 'none', env: {}, identity: { userAgent: { custom: 'Athena/0.1' }, attribution: null },
      fetch: async (url, options) => {
        if (sent || String(url) !== 'https://api.deepseek.com/chat/completions' || options?.method !== 'POST') throw new Error('Request denied.');
        sent = true;
        const result = await fetchRequest(url, { ...options, redirect: 'error' });
        status = result.status;
        return result;
      },
      onProviderStreamEvent: event => {
        if (event && typeof event === 'object' && 'usage' in event && event.usage) {
          sawUsage = true;
          reportedUsage = hasReportedUsage(event.usage);
        }
      },
    }).result();
    if (sawUsage && !reportedUsage) return { status: 'failed', reason: 'usage' };
    if (response.stopReason !== 'stop' && response.stopReason !== 'length') return failure();
    const usage = reportedUsage ? parseTokenUsage(response.usage) : undefined;
    if (!usage) return { status: 'failed', reason: 'usage' };
    // Never return provider text, error bodies, headers, or keys to main/renderer/logs.
    return { status: 'success', usage };
  } catch {
    return failure();
  }
}
