import type { Api, Model } from '@earendil-works/pi-ai';

export type ModelRole = 'conversation' | 'investigator';
export type ConversationRoute = 'chatgpt' | 'api-key';
/** Secret configuration is retained in protected storage; references are immutable hashes. */
export interface PinnedModel { model: Model<Api>; keyRef?: string; headerRefs: Record<string, string>; authHeader: boolean }
export interface ApiConversationConfig { conversation: PinnedModel; investigator: PinnedModel }
export interface ApiGrant { token: string; headers: Record<string, string> }
export const API_OUTPUT_TOKENS = 1024;
export function requestAllowance(contextBytes: number): number { return contextBytes * 6 + 16_384; }
export interface ApiSettingsSnapshot {
  route: ConversationRoute;
  conversation: string;
  investigator: string;
  models: { ref: string; provider: string; id: string; name: string; endpoint: string; api: string; cost: Model<Api>['cost']; contextWindow: number; maxTokens: number; reasoning: boolean }[];
  destinations: { id: string; provider: string; endpoint: string; approved: boolean }[];
  helpers: { id: string; command: string; approved: boolean }[];
  credentials: { provider: string; stored: boolean; revoked: boolean }[];
  protectedStorageAvailable: boolean;
  literalWarning: boolean;
}
export interface ApiSettingsBridge {
  snapshot(): Promise<ApiSettingsSnapshot>;
  configure(json: string): Promise<ApiSettingsSnapshot>;
  importModels(): Promise<ApiSettingsSnapshot>;
  select(route: ConversationRoute, conversation: string, investigator: string): Promise<ApiSettingsSnapshot>;
  credential(provider: string, key: string): Promise<ApiSettingsSnapshot>;
  revokeCredential(provider: string): Promise<ApiSettingsSnapshot>;
  approveDestination(id: string, approved: boolean): Promise<ApiSettingsSnapshot>;
  approveHelper(id: string, approved: boolean): Promise<ApiSettingsSnapshot>;
}
