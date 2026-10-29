export const CONNECTION_PROMPT = 'Reply with exactly: Athena connection OK';
export const CONNECTION_MAX_TOKENS = 32;
export const CONNECTION_TIMEOUT_MS = 20_000;
export const PROVIDER_CONSENT = 'I approve DeepSeek as a provider for future repository content I explicitly choose to send. This does not start investigation, grant folder or secret access, or approve paid work.';

export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  toolCalls: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  verifiedAt: string;
}
export interface ModelWorkspace {
  model: ModelInfo;
  credentialConfigured: boolean;
  protectedStorageAvailable: boolean;
  providerConsent: { text: string; acceptedAt: string } | null;
  gate: { limitUsd: number; reservedUsd: number; estimateUsd: number | null };
  test: { status: 'idle' | 'running' | 'success' | 'failed' | 'cancelled'; message: string; usage?: TokenUsage; estimatedCostUsd?: number };
}
export interface ModelBridge {
  snapshot(): Promise<ModelWorkspace>;
  saveKey(key: string): Promise<ModelWorkspace>;
  consent(text: string): Promise<ModelWorkspace>;
  revokeConsent(): Promise<ModelWorkspace>;
  test(): Promise<ModelWorkspace>;
  cancel(): Promise<ModelWorkspace>;
}
