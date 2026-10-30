export const CHATGPT_PROMPT = 'Reply with exactly: Athena connection OK';
export const CHATGPT_TEST_TIMEOUT = 20_000;
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

export type ChatGPTFailure = 'authentication' | 'permission' | 'ineligible' | 'quota' | 'unavailable' | 'model' | 'protocol' | 'storage' | 'cancelled' | 'context';
export const CHATGPT_ERRORS: Record<ChatGPTFailure, string> = {
  context: 'This conversation exceeds the context limit. Start a new conversation; history was not silently shortened or summarized.',
  authentication: 'ChatGPT authorization is unavailable or was rejected. Connect or reconnect in Model settings; no other billing route was used.',
  permission: 'ChatGPT plan permission is missing. Choose Enable ChatGPT plan use and review the permissions.',
  ineligible: 'This ChatGPT account, workspace, region, or policy does not allow this request. Check eligibility in ChatGPT settings.',
  quota: 'A ChatGPT usage limit was reached. Review ChatGPT settings → Usage; Athena will not change accounts or billing routes.',
  unavailable: 'ChatGPT is temporarily unavailable or the network request failed. Retry explicitly when ready.',
  model: 'The selected model is unavailable. Refresh models and explicitly choose an available model.',
  protocol: 'ChatGPT returned an invalid or incomplete response. No fallback was used. Retry or check integration compatibility.',
  storage: 'Could not safely read or save ChatGPT credentials. Unlock your login Keychain, check local storage, then restart Athena. No plaintext fallback is available.',
  cancelled: 'ChatGPT operation cancelled. Cancellation may not prevent usage already incurred.',
};
export interface ChatGPTUsage { input: number; output: number; cachedInput: number }
export type ChatGPTResult = { status: 'success'; usage?: ChatGPTUsage } | { status: 'failed'; reason: ChatGPTFailure };
export interface ChatGPTModel { id: string; name: string }
export interface ChatGPTSnapshot {
  protectedStorageAvailable: boolean;
  account: { email?: string; connected: boolean; planEnabled: boolean; reconnectRequired: boolean } | null;
  models: ChatGPTModel[];
  selectedModel: string | null;
  activity: 'idle' | 'login' | 'catalog' | 'test' | 'disconnect' | 'conversation';
  message: string;
  test: { status: 'idle' | 'running' | 'success' | 'failed' | 'cancelled'; usage?: ChatGPTUsage };
}
export interface ChatGPTBridge {
  snapshot(): Promise<ChatGPTSnapshot>;
  connect(): Promise<ChatGPTSnapshot>;
  enablePlan(): Promise<ChatGPTSnapshot>;
  refreshModels(): Promise<ChatGPTSnapshot>;
  selectModel(id: string): Promise<ChatGPTSnapshot>;
  test(): Promise<ChatGPTSnapshot>;
  cancel(): Promise<ChatGPTSnapshot>;
  disconnect(): Promise<ChatGPTSnapshot>;
  forget(): Promise<ChatGPTSnapshot>;
  openUsage(): Promise<void>;
}
export function parseChatGPTUsage(value: unknown): ChatGPTUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const { input, output, cachedInput } = value as ChatGPTUsage;
  if ([input, output, cachedInput].every(n => Number.isSafeInteger(n) && n >= 0) && cachedInput <= input) return { input, output, cachedInput };
}
export function parseChatGPTResult(value: unknown): ChatGPTResult {
  if (value && typeof value === 'object') {
    const result = value as Record<string, unknown>;
    if (result.status === 'success') return { status: 'success', usage: parseChatGPTUsage(result.usage) };
    if (result.status === 'failed' && typeof result.reason === 'string' && Object.hasOwn(CHATGPT_ERRORS, result.reason)) {
      return { status: 'failed', reason: result.reason as ChatGPTFailure };
    }
  }
  return { status: 'failed', reason: 'protocol' };
}
