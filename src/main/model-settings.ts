import { DatabaseSync } from 'node:sqlite';
import { DEEPSEEK_INFO } from './deepseek-model';
import { CONNECTION_MAX_TOKENS, CONNECTION_TIMEOUT_MS, PROVIDER_CONSENT, type ModelInfo, type ModelWorkspace, type TokenUsage } from '../shared/models';

type SavedState = Pick<ModelWorkspace, 'model' | 'providerConsent' | 'test'> & { reservedNanoUsd: number };
const NANO_USD = 1_000_000_000;

function estimateTestReservationNanoUsd(model: ModelInfo): number | null {
  const cost = model.cost;
  if (!cost || [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some(rate => !Number.isFinite(rate) || rate < 0) || cost.input <= 0 || cost.output <= 0) return null;
  // Only the fixed short ASCII prompt, no tools/system/history. 1024 input tokens
  // deliberately overestimates its bytes and protocol overhead; assume no cache savings.
  return Math.ceil((1024 * Math.max(cost.input, cost.cacheRead, cost.cacheWrite) + CONNECTION_MAX_TOKENS * cost.output) * 1000);
}

/** Only these application-authored messages may cross the privileged bridge. */
export class ModelSettingsError extends Error {}

export interface CredentialProtection {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Uint8Array): string;
}
export type ConnectionFailureReason = 'authentication' | 'provider' | 'usage';
export type ConnectionResult = { status: 'success'; usage: TokenUsage } | { status: 'failed'; reason: ConnectionFailureReason };
export interface ConnectionProvider {
  start(key: string): { result: Promise<ConnectionResult>; cancel(): void };
}

/** Application-owned state only; no Pi or repository credential discovery. */
export class ModelSettings {
  private readonly db: DatabaseSync;
  private closed = false;
  private state: SavedState;
  private active?: { result: Promise<ConnectionResult>; cancel(): void };
  private timer?: ReturnType<typeof setTimeout>;
  constructor(path: string, private readonly protection: CredentialProtection, private readonly provider: ConnectionProvider,
    private readonly notify: () => void = () => {}, model: ModelInfo = DEEPSEEK_INFO) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS credential (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS model_state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
    `);
    const saved = this.db.prepare('SELECT value FROM model_state WHERE id = 1').get();
    this.state = saved ? JSON.parse(String(saved.value)) as SavedState : {
      model: structuredClone(model), providerConsent: null, reservedNanoUsd: 0,
      test: { status: 'idle', message: 'No connection test sent.' },
    };
    if (this.state.test.status === 'running') this.state.test = { status: 'cancelled', message: 'Connection test interrupted. An already-sent request may still incur charges; its reservation is retained.' };
    this.save(this.state);
  }
  private save(state: SavedState): void {
    this.db.prepare('INSERT OR REPLACE INTO model_state VALUES (1, ?)').run(JSON.stringify(state));
    this.state = state;
  }
  snapshot(): ModelWorkspace {
    const estimateNanoUsd = estimateTestReservationNanoUsd(this.state.model);
    return {
      model: structuredClone(this.state.model), credentialConfigured: !!this.db.prepare('SELECT id FROM credential').get(),
      protectedStorageAvailable: this.protection.available(), providerConsent: structuredClone(this.state.providerConsent),
      gate: { limitUsd: 1, reservedUsd: this.state.reservedNanoUsd / NANO_USD,
        estimateUsd: estimateNanoUsd === null ? null : estimateNanoUsd / NANO_USD },
      test: structuredClone(this.state.test),
    };
  }
  saveKey(key: string): ModelWorkspace {
    if (!this.protection.available()) throw new ModelSettingsError('macOS protected storage is unavailable. Unlock your login Keychain and retry.');
    if (!key.trim() || key.length > 512 || /[\s\x00-\x1f\x7f]/u.test(key)) throw new ModelSettingsError('Enter a valid DeepSeek API key without spaces.');
    try {
      const encrypted = this.protection.encrypt(key);
      this.db.prepare('INSERT OR REPLACE INTO credential VALUES (1, ?)').run(encrypted);
    } catch { throw new ModelSettingsError('Could not protect and save the key. Unlock your login Keychain and check local storage.'); }
    return this.snapshot();
  }
  consent(text: string): ModelWorkspace {
    if (text !== PROVIDER_CONSENT) throw new ModelSettingsError('Review and accept the displayed DeepSeek provider permission.');
    this.save({ ...this.state, providerConsent: { text, acceptedAt: new Date().toISOString() } });
    return this.snapshot();
  }
  revokeConsent(): ModelWorkspace {
    this.save({ ...this.state, providerConsent: null });
    return this.snapshot();
  }
  testConnection(): ModelWorkspace {
    if (this.active) throw new ModelSettingsError('A connection test is already running.');
    if (this.state.model.id !== DEEPSEEK_INFO.id || this.state.model.provider !== DEEPSEEK_INFO.provider || this.state.model.api !== DEEPSEEK_INFO.api) {
      throw new ModelSettingsError('Unsupported saved model configuration. Update Athena to support this configuration before testing; no fallback was used.');
    }
    const reservation = estimateTestReservationNanoUsd(this.state.model);
    if (reservation === null) throw new ModelSettingsError("Pricing is missing or invalid. Update Athena's model configuration with verified prices before testing.");
    if (this.state.reservedNanoUsd + reservation > NANO_USD) throw new ModelSettingsError('The conservative estimate cannot fit the remaining $1 application cost gate. No request was sent.');
    if (!this.protection.available()) throw new ModelSettingsError('Unlock your macOS login Keychain before testing.');
    const encrypted = this.db.prepare('SELECT encrypted FROM credential WHERE id = 1').get()?.encrypted;
    if (!(encrypted instanceof Uint8Array)) throw new ModelSettingsError('Save a DeepSeek API key before testing.');
    let key: string;
    try { key = this.protection.decrypt(encrypted); }
    catch { throw new ModelSettingsError('Could not unlock the saved key. Unlock your login Keychain or enter the key again.'); }
    // Persist the full reservation BEFORE sending; never refund uncertain or canceled work.
    this.save({ ...this.state, reservedNanoUsd: this.state.reservedNanoUsd + reservation,
      test: { status: 'running', message: 'Testing DeepSeek with the disclosed prompt…' } });
    let request: ReturnType<ConnectionProvider['start']>;
    try { request = this.provider.start(key); }
    catch { this.finishFailure('provider'); return this.snapshot(); }
    this.active = request;
    this.timer = setTimeout(() => this.stop(true), CONNECTION_TIMEOUT_MS);
    void request.result.then(result => {
      if (this.active !== request || this.closed) return;
      this.active = undefined;
      clearTimeout(this.timer);
      if (result.status === 'success') {
        const cost = this.state.model.cost!;
        const usage = result.usage;
        const estimatedCostUsd = (usage.input * cost.input + usage.output * cost.output + usage.cacheRead * cost.cacheRead + usage.cacheWrite * cost.cacheWrite) / 1_000_000;
        this.save({ ...this.state, test: { status: 'success', message: 'DeepSeek authentication and exchange succeeded.', usage, estimatedCostUsd } });
      } else this.finishFailure(result.reason);
      this.notify();
    }, () => {
      if (this.active !== request || this.closed) return;
      this.active = undefined;
      clearTimeout(this.timer);
      this.finishFailure('provider');
    }).catch(() => {
      // No raw native/provider errors, keys, bodies, or headers in logs or UI.
      if (!this.closed) {
        this.state.test = { status: 'failed', message: 'Could not save the test result. Check local storage and restart Athena; its cost reservation is retained.' };
        this.notify();
      }
    });
    this.notify();
    return this.snapshot();
  }
  private finishFailure(reason: ConnectionFailureReason): void {
    const messages: Record<ConnectionFailureReason, string> = {
      authentication: 'Authentication rejected. Replace the DeepSeek API key and retry.',
      provider: 'Connection test failed. Check your network, DeepSeek account balance and provider availability, then retry.',
      usage: 'DeepSeek responded, but valid token usage was not reported. Estimated cost is unavailable; its conservative reservation is retained. Retry later or check provider availability.',
    };
    this.save({ ...this.state, test: { status: 'failed', message: messages[reason] } });
    this.notify();
  }
  /** Shared non-refundable $1 application gate for API-key jobs and fixed tests. */
  reservePaidRequest(nanoUsd: number): void {
    if (!Number.isSafeInteger(nanoUsd) || nanoUsd < 0) throw new ModelSettingsError('Invalid or unknown model pricing. No request sent.');
    if (nanoUsd + this.state.reservedNanoUsd > NANO_USD) throw new ModelSettingsError('The conservative request estimate cannot fit the remaining $1 application cost gate. No request sent.');
    this.save({ ...this.state, reservedNanoUsd: this.state.reservedNanoUsd + nanoUsd });
    this.notify();
  }
  cancel(): ModelWorkspace { this.stop(false); return this.snapshot(); }
  private stop(timedOut: boolean): void {
    const request = this.active;
    if (!request) return;
    this.active = undefined;
    clearTimeout(this.timer);
    try { request.cancel(); } catch { /* Never surface transport errors. */ }
    const test: ModelWorkspace['test'] = { status: timedOut ? 'failed' : 'cancelled', message:
      `${timedOut ? 'Connection test timed out.' : 'Connection test cancelled.'} An already-sent request may still incur charges; its reservation is retained.` };
    try { this.save({ ...this.state, test }); }
    catch { this.state.test = { ...test, message: test.message + ' Result could not be saved; check local storage.' }; }
    this.notify();
  }
  close(): void { if (!this.closed) { this.stop(false); this.db.close(); this.closed = true; } }
}
