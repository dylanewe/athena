import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { API_OUTPUT_TOKENS, requestAllowance, type ApiConversationConfig, type ApiGrant, type ApiSettingsSnapshot, type ConversationRoute, type ModelRole, type PinnedModel } from '../shared/api-models';
import type { CredentialProtection } from './model-settings';
import { ApiSettingsError, DEFAULT_CONFIG, parseModelConfig, type ConfiguredModel } from './pi-model-config';
import { interpolateCredential, type CredentialHelper } from './api-credentials';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const modelRef = (p: PinnedModel) => `${p.model.provider}/${p.model.id}`;
export const destinationId = (p: PinnedModel) => hash([p.model.provider, p.model.baseUrl, p.model.api, p.authHeader, Object.entries(p.headerRefs).sort(([a], [b]) => a.localeCompare(b))]);
interface Saved {
  json: string; route: ConversationRoute; conversation: string; investigator: string;
  secrets: Record<string, string>; credentials: Record<string, string>; revoked: string[];
  destinations: Record<string, { provider: string; endpoint: string; approved: boolean }>;  helpers: Record<string, boolean>;
}
/** Athena-owned encrypted configuration. Neither Pi globals nor project resources are discovered. */
export class ApiSettings {
  private readonly db: DatabaseSync;
  private state?: Saved;
  private cache = new Map<string, Promise<string>>();
  constructor(path: string, private readonly protection: CredentialProtection, private readonly helper: CredentialHelper,
    private readonly env: NodeJS.ProcessEnv, private readonly reserve: (nanoUsd: number) => void,
    private readonly changed: () => void = () => {}) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS api_settings (id INTEGER PRIMARY KEY CHECK(id=1), encrypted BLOB NOT NULL);');
  }
  private read(): Saved {
    if (this.state) return this.state;
    const row = this.db.prepare('SELECT encrypted FROM api_settings WHERE id=1').get();
    if (!row) return { json: JSON.stringify(DEFAULT_CONFIG), route: 'chatgpt', conversation: 'deepseek/deepseek-flash', investigator: 'deepseek/deepseek-flash', secrets: {}, credentials: {}, revoked: [], destinations: {}, helpers: {} };
    try {
      if (!this.protection.available() || !(row.encrypted instanceof Uint8Array)) throw new Error();
      const saved = JSON.parse(this.protection.decrypt(row.encrypted)) as Saved;
      parseModelConfig(saved.json);
      if (!['chatgpt', 'api-key'].includes(saved.route) || !saved.secrets || !saved.credentials || !Array.isArray(saved.revoked) || !saved.destinations || !saved.helpers) throw new Error();
      return this.state = saved;
    } catch { throw new ApiSettingsError('Could not unlock or validate API-key settings. Unlock Keychain and restart Athena; no configuration was reset or substituted.'); }
  }
  private save(state: Saved): void {
    if (!this.protection.available()) throw new ApiSettingsError('Unlock macOS protected storage before saving API-key configuration. No plaintext fallback.');
    try { this.db.prepare('INSERT OR REPLACE INTO api_settings VALUES (1, ?)').run(this.protection.encrypt(JSON.stringify(state))); }
    catch { throw new ApiSettingsError('Could not protect and persist API-key configuration. Check Keychain and local storage.'); }
    this.state = state; this.changed();
  }
  private pin(entry: ConfiguredModel, state: Saved): PinnedModel {
    const ref = (secret: string) => { const id = hash(secret); state.secrets[id] = secret; return id; };
    const pinned = { model: structuredClone(entry.model), ...(entry.key ? { keyRef: ref(entry.key) } : {}),
      headerRefs: Object.fromEntries(Object.entries(entry.headers).map(([name, value]) => [name, ref(value)])), authHeader: entry.authHeader };
    state.destinations[destinationId(pinned)] ??= { provider: pinned.model.provider, endpoint: pinned.model.baseUrl, approved: false };
    return pinned;
  }
  private models(state = this.read()): PinnedModel[] { return parseModelConfig(state.json).map(entry => this.pin(entry, state)); }
  snapshot(): ApiSettingsSnapshot {
    const state = structuredClone(this.read());
    const models = this.models(state);
    const helpers = [...new Set(Object.values(state.secrets).concat(Object.values(state.credentials)).filter(value => value.startsWith('!')))];
    return { route: state.route, conversation: state.conversation, investigator: state.investigator,
      models: models.map(p => ({ ref: modelRef(p), provider: p.model.provider, id: p.model.id, name: p.model.name, endpoint: p.model.baseUrl, api: p.model.api,
        cost: p.model.cost, reasoning: p.model.reasoning, contextWindow: p.model.contextWindow, maxTokens: p.model.maxTokens })),
      destinations: Object.entries(state.destinations).map(([id, destination]) => ({ id, ...destination })),
      helpers: helpers.map(command => ({ id: hash(command), command: command.slice(1), approved: state.helpers[hash(command)] === true })),
      credentials: [...new Set([...models.map(p => p.model.provider), ...Object.values(state.destinations).map(d => d.provider)])].map(provider => ({ provider, stored: !!state.credentials[provider], revoked: state.revoked.includes(provider) })),
      protectedStorageAvailable: this.protection.available(), literalWarning: Object.values(state.secrets).some(value => !value.startsWith('!') && !value.includes('$')),
    };
  }
  configure(json: string): ApiSettingsSnapshot {
    const entries = parseModelConfig(json);
    const state = structuredClone(this.read());
    state.json = json;
    entries.forEach(entry => this.pin(entry, state));
    // Keep missing selections visibly invalid. Configuration edits never switch routes.
    this.save(state); return this.snapshot();
  }
  select(route: ConversationRoute, conversation: string, investigator: string): ApiSettingsSnapshot {
    const state = structuredClone(this.read()), models = this.models(state);
    if (!['chatgpt', 'api-key'].includes(route) || !models.some(p => modelRef(p) === conversation) || !models.some(p => modelRef(p) === investigator)) throw new ApiSettingsError('Select configured models for both API-key roles. No fallback was selected.');
    this.save({ ...state, route, conversation, investigator }); return this.snapshot();
  }
  credential(provider: string, key: string): ApiSettingsSnapshot {
    const state = structuredClone(this.read());
    if (!this.models(state).some(p => p.model.provider === provider) || !key.trim() || key.length > 8192 || key.includes('\0')) throw new ApiSettingsError('Choose a configured provider and a nonempty credential source.');
    state.credentials[provider] = key; state.revoked = state.revoked.filter(id => id !== provider);
    this.cache.clear(); this.save(state); return this.snapshot();
  }
  revokeCredential(provider: string): ApiSettingsSnapshot {
    const state = structuredClone(this.read()); delete state.credentials[provider];
    if (!state.revoked.includes(provider)) state.revoked.push(provider);
    this.cache.clear(); this.save(state); return this.snapshot();
  }
  approveDestination(id: string, approved: boolean): ApiSettingsSnapshot {
    const state = structuredClone(this.read());
    // Include historic destinations so revocation also covers pinned conversations.
    this.models(state);
    if (!Object.hasOwn(state.destinations, id)) throw new ApiSettingsError('Unknown provider destination.');
    state.destinations[id]!.approved = approved; this.save(state); return this.snapshot();
  }
  approveHelper(id: string, approved: boolean): ApiSettingsSnapshot {
    const state = structuredClone(this.read()); this.models(state);
    if (!Object.values(state.secrets).concat(Object.values(state.credentials)).some(value => value.startsWith('!') && hash(value) === id)) throw new ApiSettingsError('Unknown credential helper.');
    state.helpers[id] = approved; this.cache.clear(); this.save(state); return this.snapshot();
  }
  route(): ConversationRoute { return this.read().route; }
  conversationConfig(): ApiConversationConfig {
    const state = structuredClone(this.read()), models = this.models(state);
    const conversation = models.find(p => modelRef(p) === state.conversation), investigator = models.find(p => modelRef(p) === state.investigator);
    if (!conversation || !investigator) throw new ApiSettingsError('The selected API-key model is unavailable. Choose both models explicitly; no fallback.');
    this.assertApproved(conversation); this.assertApproved(investigator);
    // Persist opaque secret references before pinning them into a conversation.
    this.save(state);
    return structuredClone({ conversation, investigator });
  }
  assertApproved(pinned: PinnedModel): void {
    const state = this.read();
    if (!state.destinations[destinationId(pinned)]?.approved) throw new ApiSettingsError('Approve the exact API-key provider and endpoint in Model settings before sending repository content.');
    if (state.revoked.includes(pinned.model.provider)) throw new ApiSettingsError('API-key credentials were revoked. Save a credential source to re-enable this provider; no fallback.');
  }
  /** Current revocation/consent is checked before and after asynchronous resolution, then cost is durably reserved. */
  async grant(config: ApiConversationConfig, role: ModelRole, bytes: number, signal: AbortSignal): Promise<ApiGrant> {
    const pinned = structuredClone(config[role]);
    if (!pinned || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 2 * 1024 * 1024) throw new ApiSettingsError('Invalid bounded model request.');
    signal.throwIfAborted(); this.assertApproved(pinned);
    const state = this.read(), provider = pinned.model.provider;
    // Pi precedence: stored auth source > models.json apiKey > provider environment. No runtime override is exposed.
    const stored = state.credentials[provider];
    const source = stored ?? (pinned.keyRef ? state.secrets[pinned.keyRef] : undefined);
    let token: string;
    if (source !== undefined) token = await this.resolve(source, signal, stored !== undefined);
    else {
      // Pi provider declares its API-key variable; never invoke its ambient/OAuth resolver.
      const names: Record<string, string> = { deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
        groq: 'GROQ_API_KEY', cerebras: 'CEREBRAS_API_KEY', xai: 'XAI_API_KEY', openrouter: 'OPENROUTER_API_KEY', nvidia: 'NVIDIA_API_KEY',
        mistral: 'MISTRAL_API_KEY', fireworks: 'FIREWORKS_API_KEY', together: 'TOGETHER_API_KEY', baseten: 'BASETEN_API_KEY',
        minimax: 'MINIMAX_API_KEY', 'minimax-cn': 'MINIMAX_CN_API_KEY', moonshotai: 'MOONSHOT_API_KEY', 'kimi-coding': 'KIMI_API_KEY',
        opencode: 'OPENCODE_API_KEY', 'opencode-go': 'OPENCODE_API_KEY', huggingface: 'HF_TOKEN', zai: 'ZAI_API_KEY' };
      const name = names[provider];
      if (!name || !this.env[name]) throw new ApiSettingsError('No API key resolved. Save a protected source or configure the provider API-key environment variable before launch.');
      token = this.env[name]!;
    }
    if (token.includes('sk-ant-oat')) throw new ApiSettingsError('OAuth/subscription tokens are outside the API-key route scope. Use a provider API key.');
    const headers: Record<string, string> = {};
    for (const [name, ref] of Object.entries(pinned.headerRefs)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || /^(host|content-length|transfer-encoding|connection)$/iu.test(name)) throw new ApiSettingsError('Unsafe provider header.');
      const value = state.secrets[ref];
      if (value === undefined) throw new ApiSettingsError('Pinned header configuration is unavailable. No fallback.');
      headers[name] = await this.resolve(value, signal, false);
    }
    if (pinned.authHeader) headers.Authorization = `Bearer ${token}`;
    if ([token, ...Object.values(headers)].some(value => !value || /[\r\n\0]/u.test(value))) throw new ApiSettingsError('Resolved credentials contain invalid header characters.');
    signal.throwIfAborted(); this.assertApproved(pinned);
    // A credential change during resolution must not release the old authority.
    if (this.read().credentials[provider] !== stored) throw new ApiSettingsError('Credential source changed while resolving. Retry explicitly.');
    const costs = [pinned.model.cost, ...(pinned.model.cost.tiers ?? [])];
    const input = Math.max(...costs.flatMap(c => [c.input, c.cacheRead, c.cacheWrite]));
    const output = Math.max(...costs.map(c => c.output));
    this.reserve(Math.ceil((requestAllowance(bytes) * input + API_OUTPUT_TOKENS * output) * 1000));
    return { token, headers };
  }
  private async resolve(source: string, signal: AbortSignal, cached: boolean): Promise<string> {
    if (!source.startsWith('!')) return interpolateCredential(source, this.env);
    const id = hash(source);
    if (!this.read().helpers[id]) throw new ApiSettingsError('Approve this exact credential helper in Model settings before execution. Changed commands require new approval.');
    let pending = cached ? this.cache.get(id) : undefined;
    if (!pending) {
      pending = this.helper(source.slice(1), signal).catch(() => { throw new ApiSettingsError('Credential helper failed or was cancelled. No secret output was retained in errors.'); });
      if (cached) this.cache.set(id, pending);
    }
    const result = await pending;
    signal.throwIfAborted();
    if (!this.read().helpers[id]) throw new ApiSettingsError('Credential helper approval was revoked.');
    if (!result.trim() || result.length > 8192) throw new ApiSettingsError('Credential helper returned empty or oversized output.');
    return result.trim();
  }
  close(): void { this.cache.clear(); this.db.close(); }
}
