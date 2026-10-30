import { createHash } from 'node:crypto';
import type { ConversationBinding } from '../shared/live';
import { CHATGPT_ERRORS, CHATGPT_TEST_TIMEOUT, type ChatGPTModel, type ChatGPTResult, type ChatGPTSnapshot } from '../shared/chatgpt';
import { ChatGPTError, planEnabled, type OAuthProtocol, type Registration } from './chatgpt-protocol';
import { ChatGPTStore, type ChatGPTRecord } from './chatgpt-store';

export interface ChatGPTProvider { start(token: string, model: string): { result: Promise<ChatGPTResult>; cancel(): void } }
type Activity = { kind: Exclude<ChatGPTSnapshot['activity'], 'idle'>; controller: AbortController };

/** Serializes all durable mutations, including refresh rotation. Cancellation removes request authority immediately. */
export class ChatGPTSettings {
  private active?: Activity;
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  private models: ChatGPTModel[] = [];
  private message = 'No ChatGPT request sent. Connect deliberately to discover available models.';
  private testState: ChatGPTSnapshot['test'] = { status: 'idle' };
  constructor(private readonly store: ChatGPTStore, private readonly oauth: OAuthProtocol, private readonly provider: ChatGPTProvider, private readonly notify: () => void = () => {}) {}

  snapshot(): ChatGPTSnapshot {
    let record: ChatGPTRecord | undefined;
    try { record = this.store.read(); } catch { this.message = CHATGPT_ERRORS.storage; }
    const registration = record?.registration;
    return {
      protectedStorageAvailable: this.store.available(),
      account: registration ? { ...(registration.email ? { email: registration.email } : {}), connected: !!registration.tokens, planEnabled: planEnabled(registration), reconnectRequired: !!registration.reconnectRequired } : null,
      models: structuredClone(this.models), selectedModel: record?.selectedModel ?? null,
      activity: this.active?.kind ?? 'idle', message: this.message, test: structuredClone(this.testState),
    };
  }
  private check(activity: Activity): void {
    if (this.active !== activity || (activity.kind !== 'disconnect' && (this.closing || activity.controller.signal.aborted))) throw new ChatGPTError('cancelled');
  }
  private start(kind: Activity['kind'], work: (activity: Activity) => Promise<void>): ChatGPTSnapshot {
    if (this.closing || this.active) throw new Error('Finish or cancel the current ChatGPT operation first.');
    if (!this.store.available()) throw new ChatGPTError('storage');
    const activity: Activity = { kind, controller: new AbortController() };
    this.active = activity;
    this.message = { login: 'Waiting for ChatGPT sign-in in your browser…', catalog: 'Refreshing ChatGPT models…', test: 'Testing the selected ChatGPT model…', disconnect: 'Disconnecting ChatGPT…', conversation: 'ChatGPT conversation running…' }[kind];
    this.queue = this.queue.then(async () => {
      this.check(activity);
      await work(activity);
    }).catch(error => {
      if (this.active !== activity) return;
      this.message = error instanceof ChatGPTError ? error.message : activity.controller.signal.aborted ? CHATGPT_ERRORS.cancelled : CHATGPT_ERRORS.unavailable;
      if (kind === 'test') this.testState = { status: 'failed' };
    }).finally(() => {
      if (this.active === activity) { this.active = undefined; this.notify(); }
    });
    this.notify();
    return this.snapshot();
  }
  connect(consent = false): ChatGPTSnapshot {
    return this.start('login', async activity => {
      const record = this.store.initialize();
      const registration = await this.oauth.login(record.hostId, record.registration, consent, activity.controller.signal);
      this.check(activity);
      this.store.write({ ...record, registration });
      this.models = [];
      this.testState = { status: 'idle' };
      if (!planEnabled(registration)) { this.message = 'Signed in — ChatGPT plan permission missing. Choose Enable ChatGPT plan use.'; return; }
      // This automatic catalog fetch is explicitly disclosed with the sign-in action. It is not generation.
      await this.loadModels(activity);
      this.message = this.models.length
        ? 'ChatGPT signed in. Eligible tests use your ChatGPT plan or enabled credits. Choose a model to test; new conversations use your selected ChatGPT model.'
        : 'ChatGPT signed in, but no models are available. Check account eligibility or refresh models later. No generation request was sent.';
    });
  }
  refreshModels(): ChatGPTSnapshot {
    return this.start('catalog', async activity => { this.models = []; await this.loadModels(activity); this.message = this.models.length ? 'ChatGPT models refreshed. Select a model explicitly before testing.' : 'No models are available for this account. Check eligibility or retry later.'; });
  }
  private invalidate(record: ChatGPTRecord): void {
    const r = record.registration;
    if (r) { const { tokens: _tokens, ...identity } = r; this.store.write({ ...record, registration: { ...identity, reconnectRequired: true } }); }
    this.models = [];
  }
  private async access(activity: Activity): Promise<{ token: string; record: ChatGPTRecord }> {
    this.check(activity);
    let record = this.store.read();
    if (!record?.registration?.tokens) throw new ChatGPTError('authentication');
    if (!planEnabled(record.registration)) throw new ChatGPTError('permission');
    if (record.registration.tokens.expiresAt <= Date.now() + 60_000) {
      let refreshed: Registration;
      try { refreshed = await this.oauth.refresh(record.registration); }
      catch (error) {
        if (error instanceof ChatGPTError && (error.reason === 'authentication' || error.reason === 'protocol')) this.invalidate(record);
        throw error;
      }
      // Do NOT check cancellation before this commit: rotating refresh credentials must survive a cancelled caller.
      record = { ...record, registration: refreshed };
      this.store.write(record);
      this.check(activity);
      if (!planEnabled(refreshed)) { this.models = []; throw new ChatGPTError('permission'); }
    }
    this.check(activity);
    return { token: record.registration!.tokens!.accessToken!, record };
  }
  private async loadModels(activity: Activity): Promise<void> {
    const { token, record } = await this.access(activity);
    try {
      const models = await this.oauth.catalog(token, activity.controller.signal);
      this.check(activity);
      this.models = models;
    } catch (error) {
      if (error instanceof ChatGPTError && error.reason === 'authentication') this.invalidate(record);
      throw error;
    }
  }
  selectModel(id: string): ChatGPTSnapshot {
    if (this.closing || this.active) throw new Error('Finish the current ChatGPT operation first.');
    if (!this.models.some(model => model.id === id)) throw new ChatGPTError('model');
    const record = this.store.read();
    if (!record?.registration || !planEnabled(record.registration)) throw new ChatGPTError('permission');
    this.store.write({ ...record, selectedModel: id });
    this.testState = { status: 'idle' };
    this.message = 'ChatGPT model selected. No generation request has been sent.';
    return this.snapshot();
  }
  test(): ChatGPTSnapshot {
    return this.start('test', async activity => {
      const record = this.store.read();
      const model = record?.selectedModel;
      if (!model || !this.models.some(entry => entry.id === model)) throw new ChatGPTError('model');
      this.testState = { status: 'running' };
      this.notify();
      const deadline = setTimeout(() => { if (this.active === activity) this.cancel('ChatGPT test timed out. Cancellation may not prevent usage already incurred.'); }, CHATGPT_TEST_TIMEOUT);
      try {
        const { token, record: authorized } = await this.access(activity);
        this.check(activity);
        const request = this.provider.start(token, model);
        const abort = () => request.cancel();
        activity.controller.signal.addEventListener('abort', abort, { once: true });
        let result: ChatGPTResult;
        try { result = await request.result; }
        finally { activity.controller.signal.removeEventListener('abort', abort); }
        this.check(activity);
        if (result.status === 'failed') {
          if (result.reason === 'authentication') this.invalidate(authorized);
          if (['permission', 'ineligible', 'model', 'quota'].includes(result.reason)) this.models = [];
          throw new ChatGPTError(result.reason);
        }
        this.testState = { status: 'success', ...(result.usage ? { usage: result.usage } : {}) };
        this.message = 'ChatGPT subscription exchange completed. ' + (result.usage ? 'Reported token usage is shown below.' : 'Token usage was not reported; no usage or dollar cost has been invented.');
      } finally { clearTimeout(deadline); }
    });
  }
  /** Local identity lookup only; no network and no credential reaches the renderer. */
  conversationBinding(pinned?: ConversationBinding): ConversationBinding {
    const record = this.store.read();
    const saved = record?.registration;
    if (!saved?.tokens) throw new ChatGPTError('authentication');
    if (!planEnabled(saved)) throw new ChatGPTError('permission');
    const registration = createHash('sha256').update(JSON.stringify([record!.hostId, saved.clientId, saved.issuer, saved.subject])).digest('hex');
    if (pinned && pinned.registration !== registration) throw new ChatGPTError('authentication');
    const model = pinned?.model ?? record?.selectedModel;
    if (!model) throw new ChatGPTError('model');
    return { registration, model };
  }

  /** Owns the same serialized refresh/mutation queue as login/test/disconnect. */
  async conversation<T>(binding: ConversationBinding, signal: AbortSignal,
    work: (access: () => Promise<string>, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing || this.active) throw new Error('Finish the current ChatGPT operation first.');
    signal.throwIfAborted();
    this.conversationBinding(binding);
    const activity: Activity = { kind: 'conversation', controller: new AbortController() };
    this.active = activity;
    const abort = () => { if (this.active === activity) this.cancel(); };
    signal.addEventListener('abort', abort, { once: true });
    this.message = 'ChatGPT conversation running. Stop to cancel; usage already incurred may remain.';
    this.notify();
    const pending = this.queue.then(async () => {
      this.check(activity);
      if (!this.models.length) await this.loadModels(activity);
      if (!this.models.some(model => model.id === binding.model)) throw new ChatGPTError('model');
      const access = async () => {
        this.check(activity);
        this.conversationBinding(binding);
        const value = await this.access(activity);
        this.check(activity);
        return value.token;
      };
      return work(access, activity.controller.signal);
    }).catch(error => {
      if (this.active === activity && error instanceof ChatGPTError) {
        const record = this.store.read();
        if (error.reason === 'authentication' && record) this.invalidate(record);
        if (['permission', 'ineligible', 'model', 'quota'].includes(error.reason)) this.models = [];
        this.message = error.message;
      }
      throw error;
    }).finally(() => {
      signal.removeEventListener('abort', abort);
      if (this.active === activity) { this.active = undefined; this.notify(); }
    });
    // Rejections are returned to the requesting job, never poison the mutation queue.
    this.queue = pending.then(() => {}, () => {});
    return pending;
  }

  cancel(message = CHATGPT_ERRORS.cancelled): ChatGPTSnapshot {
    const active = this.active;
    if (active && active.kind !== 'disconnect') {
      this.active = undefined;
      active.controller.abort();
      if (active.kind === 'test') this.testState = { status: 'cancelled' };
      this.message = message;
      this.notify();
    }
    return this.snapshot();
  }
  disconnect(): ChatGPTSnapshot {
    if (this.active?.kind === 'disconnect') throw new Error('Disconnect is already running.');
    this.cancel();
    return this.start('disconnect', async activity => {
      const record = this.store.read();
      const saved = record?.registration;
      this.models = [];
      this.testState = { status: 'idle' };
      if (!record || !saved) { this.message = 'No ChatGPT account is connected.'; return; }
      const { tokens: _tokens, reconnectRequired: _reconnect, ...identity } = saved;
      // Forget locally before remote IO, even when shutdown or revocation fails. Queue waits for in-flight refresh rotation first.
      this.store.write({ ...record, registration: identity });
      const confirmed = await this.oauth.revoke(saved, activity.controller.signal);
      this.message = confirmed ? 'ChatGPT disconnected. Tokens removed; the single registration is retained for reconnect.' : 'ChatGPT disconnected locally. Remote revocation was not confirmed; disconnect Athena in ChatGPT settings. The registration is retained for reconnect.';
    });
  }
  forget(): ChatGPTSnapshot {
    if (this.active || this.closing) throw new Error('Finish the current ChatGPT operation first.');
    const record = this.store.read();
    if (record?.registration?.tokens) throw new Error('Disconnect ChatGPT before forgetting its registration.');
    if (record) this.store.write({ version: 1, hostId: record.hostId });
    this.models = [];
    this.testState = { status: 'idle' };
    this.message = 'ChatGPT registration forgotten locally. Next sign-in creates a new registration; the installation ID is unchanged.';
    return this.snapshot();
  }
  async close(): Promise<void> {
    this.cancel();
    this.closing = true;
    // Let queued disconnect finish local deletion, and let a pending refresh commit its rotation before shutdown.
    if (this.active?.kind === 'disconnect') this.active.controller.abort();
    await this.queue;
    this.store.close();
  }
}
