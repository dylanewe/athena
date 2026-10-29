import type { Model } from '@earendil-works/pi-ai';
import type { ModelInfo } from '../shared/models';

// Athena-owned, pinned Pi-compatible configuration. Never load Pi auth/models or env keys.
// Verified 2026-10-29: https://api-docs.deepseek.com/quick_start/pricing
// and https://api-docs.deepseek.com/guides/thinking_mode (use peak USD/1M rates).
export const DEEPSEEK_MODEL: Model<'openai-completions'> = {
  provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash',
  api: 'openai-completions', baseUrl: 'https://api.deepseek.com',
  reasoning: true, input: ['text', 'image'], contextWindow: 1_000_000, maxTokens: 384_000,
  cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek', supportsStrictMode: true },
};
export const DEEPSEEK_INFO: ModelInfo = {
  provider: DEEPSEEK_MODEL.provider, id: DEEPSEEK_MODEL.id, name: DEEPSEEK_MODEL.name,
  api: DEEPSEEK_MODEL.api, reasoning: DEEPSEEK_MODEL.reasoning, input: [...DEEPSEEK_MODEL.input],
  contextWindow: DEEPSEEK_MODEL.contextWindow, maxTokens: DEEPSEEK_MODEL.maxTokens,
  cost: { ...DEEPSEEK_MODEL.cost }, toolCalls: true, verifiedAt: '2026-10-29',
};
