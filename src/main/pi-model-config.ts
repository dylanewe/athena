import { Type, type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { parse, type ParseError } from 'jsonc-parser';
import { ProviderCompatSchema } from '@earendil-works/pi-ai/providers/compat-schema';
import { ModelCostSchema, ModelInputLimitsSchema, ModelInputModalitySchema, ModelPromptCacheSchema, ThinkingLevelMapSchema } from '@earendil-works/pi-ai/providers/model-schema';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model } from '@earendil-works/pi-ai';
import { DEEPSEEK_MODEL } from './deepseek-model';

export class ApiSettingsError extends Error {}
// Pi coding-agent 1.4.0 model-config schema, using the exact pi-ai metadata schemas.
// Athena rejects unknown fields (including nested compat capabilities) instead of ignoring them.
const sampling = Type.Record(Type.String(), Type.Unknown());
const byLevel = Type.Object(Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(key => [key, Type.Optional(sampling)])));
const metadata = {
  name: Type.Optional(Type.String({ minLength: 1 })), reasoning: Type.Optional(Type.Boolean()),
  thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema), input: Type.Optional(Type.Array(ModelInputModalitySchema)),
  inputLimits: Type.Optional(ModelInputLimitsSchema), cost: Type.Optional(ModelCostSchema), promptCache: Type.Optional(ModelPromptCacheSchema),
  contextWindow: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), maxTokens: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  samplingParams: Type.Optional(sampling), samplingParamsByThinkingLevel: Type.Optional(byLevel),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())), compat: Type.Optional(ProviderCompatSchema),
};
const schema = Type.Object({
  $schema: Type.Optional(Type.String()),
  providers: Type.Record(Type.String(), Type.Object({
    name: Type.Optional(Type.String({ minLength: 1 })), baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    apiKey: Type.Optional(Type.String({ minLength: 1 })), api: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())), compat: Type.Optional(ProviderCompatSchema), authHeader: Type.Optional(Type.Boolean()),
    models: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), api: Type.Optional(Type.String({ minLength: 1 })), baseUrl: Type.Optional(Type.String({ minLength: 1 })), ...metadata }))),
    modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Object({ ...metadata, cost: Type.Optional(Type.Partial(ModelCostSchema)) }))),
  })),
});
function strictObjects(schema: TSchema): void {
  const s = schema as unknown as Record<string, unknown>;
  if (s.type === 'object' && s.properties) s.additionalProperties = false;
  for (const [key, child] of Object.entries(s)) {
    if (key === 'properties' || key === 'patternProperties') {
      for (const nested of Object.values(child as object)) strictObjects(nested as TSchema);
    } else if (Array.isArray(child)) {
      for (const nested of child) if (nested && typeof nested === 'object') strictObjects(nested as TSchema);
    } else if (child && typeof child === 'object') strictObjects(child as TSchema);
  }
}
strictObjects(schema);
const validator = Compile(schema);
type Config = Static<typeof schema>;
export interface ConfiguredModel { model: Model<Api>; key?: string; headers: Record<string, string>; authHeader: boolean }
// Provider is implicit in models.json entries, unlike Model. Avoid an extra incompatible property.
export const DEFAULT_CONFIG = { providers: { deepseek: { models: [Object.fromEntries(Object.entries(DEEPSEEK_MODEL).filter(([key]) => key !== 'provider'))] } } };
const SUPPORTED_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages']);
function merge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base, ...override };
  for (const key of ['cost', 'compat', 'headers', 'samplingParams', 'inputLimits', 'promptCache', 'thinkingLevelMap', 'samplingParamsByThinkingLevel']) {
    if (base[key] && override[key]) result[key] = { ...(base[key] as object), ...(override[key] as object) };
  }
  for (const key of ['openRouterRouting', 'vercelGatewayRouting', 'chatTemplateKwargs', 'chatTemplateArgs']) {
    const b = base.compat as Record<string, unknown> | undefined, o = override.compat as Record<string, unknown> | undefined;
    if (b?.[key] && o?.[key]) (result.compat as Record<string, unknown>)[key] = { ...(b[key] as object), ...(o[key] as object) };
  }
  const b = base.inputLimits as { images?: { resize?: object } } | undefined, o = override.inputLimits as { images?: { resize?: object } } | undefined;
  if (b?.images && o?.images) (result.inputLimits as { images: object }).images = { ...b.images, ...o.images, resize: { ...b.images.resize, ...o.images.resize } };
  if (base.samplingParamsByThinkingLevel && override.samplingParamsByThinkingLevel) {
    const levels = result.samplingParamsByThinkingLevel as Record<string, object>;
    for (const level of Object.keys(levels)) levels[level] = { ...(base.samplingParamsByThinkingLevel as Record<string, object>)[level], ...(override.samplingParamsByThinkingLevel as Record<string, object>)[level] };
  }
  return result;
}
export function parseModelConfig(json: string): ConfiguredModel[] {
  if (Buffer.byteLength(json) > 256 * 1024) throw new ApiSettingsError('Model configuration exceeds 256 KiB.');
  const errors: ParseError[] = [];
  const parsed: unknown = parse(json.replace(/^\uFEFF/u, ''), errors, { allowTrailingComma: false });
  if (errors.length || !validator.Check(parsed)) throw new ApiSettingsError('Invalid Pi models.json. Check fields, metadata, and compatibility capabilities; unknown fields are rejected.');
  const config = parsed as Config;
  const output: ConfiguredModel[] = [];
  for (const [provider, settings] of Object.entries(config.providers)) {
    if (['openai-codex', 'github-copilot', 'amazon-bedrock', 'google-vertex'].includes(provider)) throw new ApiSettingsError('Subscription and ambient-cloud providers are outside the API-key route scope.');
    if (!/^[a-zA-Z0-9_-]+$/u.test(provider)) throw new ApiSettingsError('Provider IDs must contain only letters, digits, hyphens, or underscores.');
    const builtins = getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0]).filter(m => !m.type || m.type === 'chat') as Model<Api>[];
    const models = new Map(builtins.map(m => [m.id, structuredClone(m)]));
    if (provider === 'deepseek') models.set(DEEPSEEK_MODEL.id, structuredClone(DEEPSEEK_MODEL));
    for (const [id, m] of models) models.set(id, { ...m, baseUrl: settings.baseUrl ?? m.baseUrl, compat: { ...m.compat, ...settings.compat } });
    const seen = new Set<string>();
    for (const definition of settings.models ?? []) {
      if (!definition.id) throw new ApiSettingsError('A model ID is required.');
      if (seen.has(definition.id)) throw new ApiSettingsError('Duplicate model IDs are not allowed.');
      seen.add(definition.id);
      const defaults = models.get(definition.id) ?? [...models.values()].find(m => m.api === settings.api) ?? [...models.values()].find(m => m.api === 'openai-completions') ?? [...models.values()][0];
      // Pi models entries replace metadata; only API and endpoint inherit provider defaults.
      models.set(definition.id, { ...definition, provider, name: definition.name ?? definition.id,
        api: definition.api ?? settings.api ?? defaults?.api, baseUrl: definition.baseUrl ?? settings.baseUrl ?? defaults?.baseUrl,
        compat: { ...settings.compat, ...definition.compat } } as Model<Api>);
    }
    for (const [id, override] of Object.entries(settings.modelOverrides ?? {})) {
      const existing = models.get(id);
      if (!existing) throw new ApiSettingsError('A model override references an unknown model ID. No override was ignored.');
      models.set(id, merge(existing as unknown as Record<string, unknown>, override) as unknown as Model<Api>);
    }
    for (const original of models.values()) {
      const model = structuredClone(original);
      // Providers whose builtins require a different auth protocol are explicitly unsupported.
      if (!SUPPORTED_APIS.has(model.api)) throw new ApiSettingsError('Unsupported API. This slice supports API-key openai-completions, openai-responses, and anthropic-messages only.');
      validateModel(model);
      output.push({ model, key: settings.apiKey, headers: { ...settings.headers, ...model.headers }, authHeader: settings.authHeader ?? false });
      delete model.headers;
    }
  }
  if (!output.length) throw new ApiSettingsError('Configure at least one model.');
  return output;
}
export function endpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiSettingsError('Models require an explicit HTTPS endpoint.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname.includes('.') || /^(localhost|127\.|0\.|\[|.*\.local$)/u.test(url.hostname)) throw new ApiSettingsError('Only hosted HTTPS API-key endpoints without credentials, query, or fragment are supported.');
  return url.href.replace(/\/$/u, '');
}
function validateModel(model: Model<Api>): void {
  model.baseUrl = endpoint(model.baseUrl);
  if (!model.input?.includes('text') || typeof model.reasoning !== 'boolean' || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1024) throw new ApiSettingsError('Each model requires text input, reasoning, contextWindow and maxTokens (at least 1024) metadata.');
  const rates = model.cost && [model.cost, ...(model.cost.tiers ?? [])];
  if (!rates || rates.some(rate => [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].some(n => !Number.isFinite(n) || n < 0))) throw new ApiSettingsError('Every model needs complete non-negative pricing, including cache rates, for the enabled $1 gate.');
  if (model.cost.tiers?.some(tier => !Number.isSafeInteger(tier.inputTokensAbove) || tier.inputTokensAbove < 0)) throw new ApiSettingsError('Pricing tiers require non-negative integer token thresholds.');
  // Sampling is free-form in Pi, but cannot override Athena authority, caps or routing.
  const forbidden = /^(model|messages|input|tools|tool_choice|max_tokens|max_completion_tokens|max_output_tokens|stream|store|reasoning|service_tier|extra_body|provider|route|models)$/iu;
  for (const params of [model.samplingParams, ...Object.values(model.samplingParamsByThinkingLevel ?? {})]) if (params && Object.keys(params).some(key => forbidden.test(key))) throw new ApiSettingsError('Sampling defaults cannot override Athena routing, tools, or paid-work limits.');
  const compat = model.compat as Record<string, unknown> | undefined;
  if (compat?.supportsMaxOutputTokens === false) throw new ApiSettingsError('This endpoint cannot enforce the required paid-request output cap.');
  if (compat?.supportsTools === false || compat?.supportsToolChoice === false) throw new ApiSettingsError('Agent models must support tool calling.');
  if (compat?.openRouterRouting || compat?.vercelGatewayRouting) throw new ApiSettingsError('Provider routing and automatic fallback configuration are outside scope.');
}
