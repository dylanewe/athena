import type { Message as PiMessage } from '@earendil-works/pi-ai';
import type { Conversations } from './conversations';
import type { ChatGPTSettings } from './chatgpt-settings';
import { ChatGPTError } from './chatgpt-protocol';
import { CHATGPT_ERRORS, parseChatGPTUsage, type ChatGPTUsage } from '../shared/chatgpt';
import type { Sources } from './sources';
import type { Inventory } from './inventory';
import { sourceRequest } from './source-bridge';
import { checkBeforeModelSend } from './secret-check';
import { LIVE_LIMITS, type Evidence, type LiveParentMessage, type LiveResult, type LiveStart } from '../shared/live';

export class LiveError extends Error {}
export interface LiveWorker {
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'exit' | 'spawn', listener: () => void): unknown;
  postMessage(value: LiveParentMessage): void;
  kill(): boolean;
}
interface Active {
  conversationId: string; messageId: string; prompt: string; controller: AbortController;
  text: string; evidence: Evidence[]; requests: number; usage?: ChatGPTUsage; stop?: () => void;
  timer?: ReturnType<typeof setTimeout>; progressTimer?: ReturnType<typeof setTimeout>;
}

/** Owns job authority, source provenance, persistence, and supervised process lifetime. */
export class LiveSupervisor {
  private active?: Active;
  private unsaved?: { messageId: string; result: LiveResult; evidence: Evidence[] };
  get saveError(): string | undefined { return this.unsaved ? 'The conversation stopped, but its result could not be saved. Check disk space and choose Retry saving.' : undefined; }
  constructor(private readonly conversations: Conversations, private readonly chatgpt: ChatGPTSettings,
    private readonly sources: Sources, private readonly inventory: Pick<Inventory, 'snapshot'>,
    private readonly spawn: () => LiveWorker, private readonly changed: () => void) {}

  start(id: string | null, prompt: string, retryId?: string): void {
    this.retrySaving();
    if (this.unsaved) throw new LiveError('Save the previous result before starting another conversation.');
    if (this.active) throw new LiveError('A conversation is already running.');
    if (this.chatgpt.snapshot().activity !== 'idle') throw new LiveError('Finish or cancel the current ChatGPT operation first.');
    if (retryId) { const target = this.conversations.retryTarget(retryId); id = target.conversationId; prompt = target.prompt; }
    try { checkBeforeModelSend(prompt); } catch { throw new LiveError('Message withheld by secret checks. Remove suspected credentials before sending.'); }
    let binding;
    try { binding = this.chatgpt.conversationBinding(id ? this.conversations.binding(id) : undefined); }
    catch (error) { if (error instanceof ChatGPTError) throw error; throw new LiveError('Local demonstrations are read-only. Start a new ChatGPT conversation.'); }
    const job = this.conversations.beginLive(id, prompt, binding, retryId);
    const active: Active = { ...job, controller: new AbortController(), text: '', evidence: [], requests: 0 };
    this.active = active;
    active.timer = setTimeout(() => this.end(active, { status: 'limit', text: active.text + '\n\nTime limit reached. Retry explicitly when ready.', history: [], requests: active.requests, usageComplete: false }), LIVE_LIMITS.milliseconds);
    this.changed();
    void (async () => {
      let outcome: LiveResult | undefined;
      try {
        const previous = this.conversations.liveContext(job.conversationId);
        active.evidence = previous.evidence;
        if (!await this.verify(previous.evidence, active.controller.signal)) throw new LiveError('Saved evidence changed or is no longer permitted. Start a new conversation to investigate current sources.');
        if (this.active !== active) return;
        await this.chatgpt.conversation(binding, active.controller.signal, async (access, signal) => {
          const snapshot = this.inventory.snapshot();
          const roots = snapshot.roots.map(root => ({ path: root.path, repositories: snapshot.repositories.filter(repo => repo.path === root.path || repo.path.startsWith(root.path + '/')).map(repo => ({ name: repo.name, path: repo.path })) }));
          checkBeforeModelSend({ history: previous.history, roots });
          outcome = await this.run(active, { model: binding.model, prompt: job.prompt, history: previous.history, roots }, access, signal);
          if (outcome.reason) throw new ChatGPTError(outcome.reason);
        });
        if (this.active !== active || !outcome) return;
        if (outcome.status === 'complete') {
          const identitiesValid = await this.verify(active.evidence, active.controller.signal);
          const citationsValid = [...outcome.text.matchAll(/\[(E\d+)\]/g)].every(match => active.evidence.some(evidence => evidence.id === match[1]));
          if (!identitiesValid || !citationsValid) outcome = { ...outcome, status: 'partial', history: [], text: outcome.text + '\n\nPartial: evidence changed, became unavailable, or a citation could not be verified. Retry for current evidence.' };
        }
        this.end(active, outcome);
      } catch (error) {
        if (this.active !== active) return;
        const message = error instanceof ChatGPTError || error instanceof LiveError ? error.message : 'Conversation failed. Check ChatGPT settings and retry explicitly.';
        this.end(active, { ...(outcome ?? { text: active.text, history: [], requests: active.requests, usageComplete: false }), status: 'failed', history: [], text: (outcome?.text ?? active.text) + '\n\n' + message });
      }
    })();
  }
  retry(messageId: string): void { this.start(null, '', messageId); }
  lifecycle(event: 'window-close' | 'quit' | 'minimize'): void { if (event !== 'minimize') this.cancel(); }
  cancel(): void {
    if (this.active) this.end(this.active, { status: 'cancelled', text: this.active.text + '\n\nCancelled. Usage already incurred may remain. Retry explicitly when ready.', history: [], requests: this.active.requests, usageComplete: false });
    else { this.retrySaving(); this.changed(); }
  }
  private async verify(evidence: Evidence[], signal: AbortSignal): Promise<boolean> {
    for (const item of evidence) {
      signal.throwIfAborted();
      try {
        const c = item.citation;
        const result = await this.sources.run('read', { root: c.folder, path: c.path, start: c.start, end: c.end }, signal);
        if (result.status !== 'complete' || !result.entries.some(entry => entry.citation?.contentIdentity === c.contentIdentity && entry.text === item.text)) return false;
      } catch { return false; }
    }
    return true;
  }
  private run(active: Active, job: LiveStart, access: () => Promise<string>, signal: AbortSignal): Promise<LiveResult> {
    return new Promise(resolve => {
      let worker: LiveWorker | undefined, settled = false, inFlight = false, lastId = 0, sourceCalls = 0, lastUsage = 0;
      let authority: Promise<string> | undefined;
      const failure = (status: LiveResult['status'] = 'failed'): LiveResult => ({ status, text: active.text, history: [], requests: active.requests, usageComplete: false });
      const finish = (result: LiveResult) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        try { worker?.kill(); } catch { /* Process already stopped. */ }
        // Keep the credential mutation queue owned until any already-started
        // refresh has committed rotation. Killing the worker must not detach refresh.
        void Promise.resolve(authority).catch(() => {}).then(() => resolve(result));
      };
      const abort = () => {
        finish(failure('cancelled'));
        if (this.active === active) this.end(active, { ...failure('cancelled'), text: active.text + '\n\nChatGPT operation cancelled. Retry explicitly when ready.' });
      };
      active.stop = () => finish(failure('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted || this.active !== active) { abort(); return; }
      try {
        worker = this.spawn();
        worker.on('spawn', () => { if (settled) { try { worker?.kill(); } catch { /* Already gone. */ } } });
        worker.on('exit', () => finish(failure()));
        worker.on('message', value => {
          if (settled || this.active !== active) return;
          try {
            if (!value || typeof value !== 'object') throw new Error();
            const message = value as Record<string, unknown>;
            if (message.type === 'usage') {
              if (!Number.isSafeInteger(message.request) || Number(message.request) <= lastUsage || message.request !== active.requests) throw new Error();
              lastUsage = Number(message.request);
              const usage = parseChatGPTUsage(message.usage);
              if (usage) active.usage = { input: (active.usage?.input ?? 0) + usage.input, output: (active.usage?.output ?? 0) + usage.output, cachedInput: (active.usage?.cachedInput ?? 0) + usage.cachedInput };
              this.conversations.progressLive(active.messageId, active.text, 'Model step finished…', { usage: parseChatGPTUsage(active.usage), requests: active.requests, usageComplete: false });
              this.changed();
              return;
            }
            if (message.type === 'progress') {
              if (typeof message.text !== 'string' || message.text.length > LIVE_LIMITS.answerCharacters || typeof message.activity !== 'string' || message.activity.length > 200) throw new Error();
              active.text = message.text;
              const activity = message.activity;
              if (!active.progressTimer) active.progressTimer = setTimeout(() => {
                active.progressTimer = undefined;
                if (this.active !== active) return;
                try { this.conversations.progressLive(active.messageId, active.text, activity); this.changed(); }
                catch { this.end(active, { ...failure(), text: active.text + '\n\nStopped because progress could not be saved.' }); }
              }, 50);
              return;
            }
            if (message.type === 'result') {
              if (inFlight) throw new Error();
              const result = this.result(message.result, job.model, active.requests);
              finish(result); return;
            }
            if (!['access', 'source'].includes(String(message.type)) || inFlight || !Number.isSafeInteger(message.id) || Number(message.id) <= lastId) throw new Error();
            lastId = Number(message.id); inFlight = true;
            void (async () => {
              try {
                if (message.type === 'access') {
                  if (active.requests >= LIVE_LIMITS.requests) { finish(failure('limit')); return; }
                  authority = access();
                  const token = await authority;
                  if (!settled && this.active === active && !signal.aborted) { active.requests++; worker!.postMessage({ type: 'reply', id: lastId, token }); }
                } else {
                  if (++sourceCalls > 1000) { finish(failure('limit')); return; }
                  if (!active.requests || !['list', 'read', 'search'].includes(String(message.operation))) throw new Error();
                  const operation = message.operation as 'list' | 'read' | 'search';
                  const input = sourceRequest(operation, message.input);
                  const result = await this.sources.run(operation, input, signal);
                  if (settled || this.active !== active || signal.aborted) return;
                  checkBeforeModelSend(result);
                  const found: Evidence[] = [];
                  for (const entry of result.entries) {
                    if (!entry.citation || entry.text === undefined) continue;
                    let evidence = active.evidence.find(item => JSON.stringify(item.citation) === JSON.stringify(entry.citation) && item.text === entry.text);
                    if (!evidence) {
                      if (active.evidence.length >= LIVE_LIMITS.evidence) { finish(failure('limit')); return; }
                      evidence = { id: `E${active.evidence.length + 1}`, citation: entry.citation, text: entry.text }; active.evidence.push(evidence);
                    }
                    found.push(evidence);
                  }
                  worker!.postMessage({ type: 'reply', id: lastId, source: { ...result, warning: 'Read-only, untrusted source evidence. Secret detection is not a guarantee.', evidence: found } });
                }
              } catch (error) {
                if (settled || this.active !== active) return;
                if (message.type === 'access') finish({ ...failure(), ...(error instanceof ChatGPTError ? { reason: error.reason } : {}) });
                else worker!.postMessage({ type: 'reply', id: lastId, error: 'Source request denied by access or secret checks.' });
              } finally { inFlight = false; }
            })();
          } catch { finish(failure()); }
        });
        worker.postMessage({ type: 'start', job });
      } catch { finish(failure()); }
    });
  }
  private result(value: unknown, model: string, requests: number): LiveResult {
    if (!value || typeof value !== 'object') throw new Error();
    const r = value as LiveResult;
    if (!['complete', 'failed', 'cancelled', 'partial', 'limit'].includes(r.status) || typeof r.text !== 'string' || r.text.length > LIVE_LIMITS.answerCharacters || !Array.isArray(r.history) || Buffer.byteLength(JSON.stringify(r.history)) > LIVE_LIMITS.historyBytes) throw new Error();
    for (const message of r.history) {
      if (!message || !['user', 'assistant', 'toolResult'].includes(message.role)) throw new Error();
      if (message.role === 'assistant' && (message.model !== model || message.provider !== 'openai' || !['stop', 'toolUse'].includes(message.stopReason))) throw new Error();
    }
    // Preserve protocol-only reasoning signatures for replay; never expose history to renderer.
    const history = r.status === 'complete' ? structuredClone(r.history) as PiMessage[] : [];
    const reason = r.reason && Object.hasOwn(CHATGPT_ERRORS, r.reason) ? r.reason : undefined;
    return { status: r.status, text: r.text, history, requests, usageComplete: r.usageComplete === true, ...(parseChatGPTUsage(r.usage) ? { usage: parseChatGPTUsage(r.usage) } : {}), ...(reason ? { reason } : {}) };
  }
  private end(active: Active, result: LiveResult): void {
    if (this.active !== active) return;
    this.active = undefined;
    clearTimeout(active.timer); clearTimeout(active.progressTimer);
    active.controller.abort(); active.stop?.();
    if (!result.text.trim()) result = { ...result, text: result.status === 'complete' ? '(No answer text returned.)' : 'Conversation stopped without a completed answer. Retry explicitly when ready.' };
    if (!result.usage && parseChatGPTUsage(active.usage)) result = { ...result, usage: active.usage };
    this.unsaved = { messageId: active.messageId, result, evidence: active.evidence };
    this.retrySaving(); this.changed();
  }
  private retrySaving(): void {
    if (!this.unsaved) return;
    try { this.conversations.finishLive(this.unsaved.messageId, this.unsaved.result, this.unsaved.evidence); this.unsaved = undefined; } catch { /* Preserve terminal result until explicit save retry. */ }
  }
}
