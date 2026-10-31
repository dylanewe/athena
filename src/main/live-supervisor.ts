import { SourceCheckouts } from './source-checkouts';
import { EnvironmentPermissions } from './environment-permissions';
import type { EnvironmentAction, EnvironmentPermission } from '../shared/environment';
import { ApiSettingsError } from './pi-model-config';
import { ModelSettingsError } from './model-settings';
import type { ApiSettings } from './api-settings';
import type { ApiConversationConfig, ApiGrant, ModelRole } from '../shared/api-models';
import type { Message as PiMessage } from '@earendil-works/pi-ai';
import type { Conversations } from './conversations';
import type { ChatGPTSettings } from './chatgpt-settings';
import { ChatGPTError } from './chatgpt-protocol';
import { CHATGPT_ERRORS, parseChatGPTUsage, type ChatGPTUsage } from '../shared/chatgpt';
import type { Sources } from './sources';
import type { Inventory } from './inventory';
import type { Knowledge } from './knowledge';
import { KNOWLEDGE_LIMITS, type KnowledgeRequest } from '../shared/knowledge';
import type { SourceCheckout, SourceIdentity, SourceScope } from '../shared/sources';
import { sourceRequest } from './source-bridge';
import { checkBeforeModelSend } from './secret-check';
import { MAX_TITLE_LENGTH } from '../shared/contracts';
import { INVESTIGATION_LIMITS, validFindings, type Exploration } from '../shared/investigation';
import { LIVE_LIMITS, type Evidence, type LiveParentMessage, type LiveResult, type LiveStart } from '../shared/live';

export class LiveError extends Error {}
export interface LiveWorker {
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'exit' | 'spawn', listener: () => void): unknown;
  postMessage(value: LiveParentMessage): void;
  kill(): boolean;
}
interface Active {
  conversationId: string; messageId: string; prompt: string; controller: AbortController; environment: EnvironmentPermissions;
  knowledgeReferences: { id: string; topic: string }[];
  checkouts: SourceCheckout[];
  retainedCheckouts: SourceCheckout[];
  apiKey?: boolean; text: string; evidence: Evidence[]; dependencies: SourceIdentity[]; scopes: SourceScope[]; dependencyCoverageComplete: boolean; exploration?: Exploration; title?: string; requests: number; usage?: ChatGPTUsage; stop?: () => void;
  timer?: ReturnType<typeof setTimeout>; progressTimer?: ReturnType<typeof setTimeout>;
}

/** Owns job authority, source provenance, persistence, and supervised process lifetime. */
export class LiveSupervisor {
  private active?: Active;
  private readonly checkouts: SourceCheckouts;
  private unsaved?: { messageId: string; result: LiveResult; evidence: Evidence[] };
  get saveError(): string | undefined { return this.unsaved ? 'The conversation stopped, but its result could not be saved. Check disk space and choose Retry saving.' : undefined; }
  constructor(private readonly conversations: Conversations, private readonly chatgpt: ChatGPTSettings,
    private readonly sources: Sources, private readonly inventory: Pick<Inventory, 'snapshot'>,
    private readonly spawn: () => LiveWorker, private readonly changed: () => void, private readonly apiSettings?: ApiSettings, private readonly knowledge?: Knowledge) { this.checkouts = new SourceCheckouts(sources, inventory); }

  start(id: string | null, prompt: string, retryId?: string): void {
    this.retrySaving();
    if (this.unsaved) throw new LiveError('Save the previous result before starting another conversation.');
    if (this.active) throw new LiveError('A conversation is already running.');
    if (retryId) { const target = this.conversations.retryTarget(retryId); id = target.conversationId; prompt = target.prompt; }
    try { this.conversations.assertClean(prompt); } catch { throw new LiveError('Message withheld by secret checks. Remove suspected credentials before sending.'); }
    let binding;
    try {
      const pinned = id ? this.conversations.binding(id) : undefined;
      if (pinned?.apiKey || (!pinned && this.apiSettings?.route() === 'api-key')) {
        const apiKey = pinned?.apiKey ?? this.apiSettings!.conversationConfig();
        this.apiSettings!.assertApproved(apiKey.conversation); this.apiSettings!.assertApproved(apiKey.investigator);
        binding = structuredClone(pinned ?? { model: apiKey.conversation.model.id, registration: '', apiKey });
      } else {
        if (this.chatgpt.snapshot().activity !== 'idle') throw new LiveError('Finish or cancel the current ChatGPT operation first.');
        binding = this.chatgpt.conversationBinding(pinned);
      }
    } catch (error) {
      if (error instanceof ChatGPTError || error instanceof ApiSettingsError || error instanceof LiveError) throw error;
      throw new LiveError('Local demonstrations are read-only. Start a new conversation.');
    }
    const job = this.conversations.beginLive(id, prompt, binding, retryId);
    const controller = new AbortController();
    const environment = new EnvironmentPermissions(this.sources, controller.signal, () => this.conversations.markEphemeral(job.messageId), () => this.cancel(), this.changed, content => this.conversations.rememberEnvironment(content));
    const active: Active = { ...job, apiKey: !!binding.apiKey, controller, environment, knowledgeReferences: [], checkouts: [], retainedCheckouts: [], text: '', evidence: [], dependencies: [], scopes: [], dependencyCoverageComplete: true, requests: 0 };
    this.active = active;
    active.timer = setTimeout(() => this.end(active, { status: 'limit', text: active.text + '\n\nTime limit reached. Retry explicitly when ready.', history: [], requests: active.requests, usageComplete: false }), LIVE_LIMITS.milliseconds);
    this.changed();
    void (async () => {
      let outcome: LiveResult | undefined;
      try {
        this.conversations.progressLive(active.messageId, '', 'Checking local checkout freshness — no model calls…'); this.changed();
        await this.knowledge?.scan(active.controller.signal);
        active.checkouts = await this.checkouts.capture(active.controller.signal);
        const previous = this.conversations.liveContext(job.conversationId);
        active.evidence = previous.evidence;
        active.retainedCheckouts = previous.checkouts ?? [];
        if (!await this.verify(previous.evidence, active.controller.signal) || (previous.evidence.length > 0 || previous.sourceBacked || active.retainedCheckouts.length > 0) && (!active.retainedCheckouts.length || !await this.checkouts.fresh(active.retainedCheckouts, active.controller.signal))) throw new LiveError('Saved evidence changed or is no longer permitted. Start a new conversation to investigate current sources.');
        if (this.active !== active) return;
        const work = async (access: (role?: ModelRole, bytes?: number) => Promise<string | ApiGrant>, signal: AbortSignal) => {
          const snapshot = this.inventory.snapshot();
          const roots = snapshot.roots.map(root => ({ path: root.path, repositories: snapshot.repositories.filter(repo => repo.path === root.path || repo.path.startsWith(root.path + '/')).map(repo => ({ name: repo.name, path: repo.path })) }));
          signal.throwIfAborted();
          this.conversations.assertClean({ history: previous.history, roots });
          outcome = await this.run(active, { ...(binding.apiKey ? { apiKey: binding.apiKey } : {}), model: binding.model, prompt: job.prompt, history: previous.history, roots, ...this.conversations.naming(job.conversationId) }, access, signal);
          if (outcome.reason && !binding.apiKey) throw new ChatGPTError(outcome.reason);
        };
        if (binding.apiKey) await work((role, bytes) => this.apiSettings!.grant(binding.apiKey!, role!, bytes!, active.controller.signal), active.controller.signal);
        else await this.chatgpt.conversation(binding, active.controller.signal, work);
        if (this.active !== active || !outcome) return;
        if (outcome.status === 'complete') {
          const identitiesValid = await this.verify(active.evidence, active.controller.signal, active.environment);
          const citationsValid = [...outcome.text.matchAll(/\[(E\d+)\]/g)].every(match => active.evidence.some(evidence => evidence.id === match[1]));
          if (!identitiesValid || !citationsValid || !await this.checkoutValid(active)) outcome = { ...outcome, status: 'partial', history: [], text: outcome.text + '\n\nPartial: the checkout changed, became unavailable, or a citation could not be verified. Retry for current evidence.' };
        }
        const candidates = outcome.exploration?.result.knowledgeCandidates ?? active.exploration?.result.knowledgeCandidates;
        if (this.knowledge && candidates?.length && outcome.status === 'complete' && !active.environment.tainted && !this.conversations.isEphemeral(active.messageId)) {
          try {
            await this.knowledge.publish({ owner: { conversationId: active.conversationId, messageId: active.messageId }, candidates,
              evidence: active.evidence, inspectedFiles: active.dependencies, inspectedScopes: active.scopes, checkouts: this.usedCheckouts(active), completed: active.dependencyCoverageComplete && (outcome.exploration?.result ?? active.exploration?.result)?.status === 'complete' && !(outcome.exploration?.result ?? active.exploration?.result)?.scopeTruncated,
              environmentExposed: active.environment.tainted, signal: active.controller.signal,
              assertPublishable: () => {
                if (this.active !== active || active.environment.tainted || this.conversations.isEphemeral(active.messageId)) throw new Error('Knowledge publication revoked.');
                this.conversations.assertClean({ outcome, exploration: active.exploration, evidence: active.evidence });
              } });
            outcome.knowledgePublication = 'published';
          } catch { outcome.knowledgePublication = 'withheld'; }
        }
        if (outcome.status === 'complete' && !await this.checkoutValid(active)) outcome = this.checkoutPartial(active, outcome);
        if (this.active === active) this.end(active, outcome);
      } catch (error) {
        if (this.active !== active) return;
        const message = error instanceof ChatGPTError || error instanceof LiveError || error instanceof ApiSettingsError || error instanceof ModelSettingsError ? error.message : 'Conversation failed. Check the pinned connection settings and retry explicitly.';
        this.end(active, { ...(outcome ?? { text: active.text, history: [], requests: active.requests, usageComplete: false }), status: 'failed', history: [], text: (outcome?.text ?? active.text) + '\n\n' + message });
      }
    })();
  }
  environmentPermissions(): EnvironmentPermission[] { return this.active?.environment.snapshot() ?? []; }
  environment(id: string, action: EnvironmentAction): void {
    if (!this.active) throw new LiveError('Environment permission expired.');
    this.active.environment.act(id, action);
  }
  revokeApiAuthority(): void { if (this.active?.apiKey) this.cancel(); }
  retry(messageId: string): void { this.start(null, '', messageId); }
  lifecycle(event: 'window-close' | 'quit' | 'minimize'): void { if (event !== 'minimize') this.cancel(); }
  cancel(): void {
    if (this.active) this.end(this.active, { status: 'cancelled', text: this.active.text + '\n\nCancelled. Environment permissions expired. Data already transmitted to a provider cannot be recalled. Usage already incurred may remain. Retry explicitly when ready.', history: [], requests: this.active.requests, usageComplete: false });
    else { this.retrySaving(); this.changed(); }
  }
  private checkoutIdentities(active: Active): SourceIdentity[] { return [...active.evidence.map(item => item.citation), ...active.dependencies, ...active.scopes, ...active.retainedCheckouts]; }
  private usedCheckouts(active: Active): SourceCheckout[] {
    return [...new Map([...this.checkouts.select(this.checkoutIdentities(active), active.checkouts), ...active.retainedCheckouts].map(snapshot => [JSON.stringify(snapshot), snapshot])).values()];
  }
  private async checkoutValid(active: Active): Promise<boolean> {
    const identities = this.checkoutIdentities(active);
    const snapshots = this.checkouts.select(identities, active.checkouts);
    return this.checkouts.covers(identities, snapshots) && await this.checkouts.fresh(this.usedCheckouts(active), active.controller.signal);
  }
  private checkoutPartial(active: Active, result?: LiveResult): LiveResult {
    return { ...(result ?? { requests: active.requests, usageComplete: false }), status: 'partial', history: [],
      text: (result?.text ?? active.text) + '\n\nPartial: the checkout changed during analysis or scan coverage was incomplete. No compatible snapshot was committed. Retry explicitly for fresh sources within a new job.' };
  }
  private async verify(evidence: Evidence[], signal: AbortSignal, environment?: EnvironmentPermissions): Promise<boolean> {
    for (const item of evidence) {
      signal.throwIfAborted();
      try {
        const c = item.citation;
        const input = { root: c.folder, path: c.path, start: c.start, end: c.end };
        const result = environment ? await environment.run('read', input) : await this.sources.run('read', input, signal);
        if (result.status !== 'complete' || !result.entries.some(entry => entry.citation?.contentIdentity === c.contentIdentity && entry.text === item.text)) return false;
      } catch { return false; }
    }
    return true;
  }
  private run(active: Active, job: LiveStart, access: (role?: ModelRole, bytes?: number) => Promise<string | ApiGrant>, signal: AbortSignal): Promise<LiveResult> {
    return new Promise(resolve => {
      let worker: LiveWorker | undefined, settled = false, inFlight = false, lastId = 0, sourceCalls = 0, lastUsage = 0;
      let authority: Promise<string | ApiGrant> | undefined;
      let knowledgeCalls = 0, knowledgeBytes = 0;
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
            if (message.type === 'checkpoint') {
              if (!message.checkpoint || typeof message.checkpoint !== 'object') throw new Error();
              const checkpoint = message.checkpoint as Pick<LiveResult, 'exploration' | 'title'>;
              if (checkpoint.exploration && !active.environment.tainted) {
                active.exploration = this.exploration(checkpoint.exploration, job.apiKey?.investigator.model.id ?? job.model, active.evidence, job.apiKey?.investigator.model.provider);
                this.conversations.progressExploration(active.messageId, active.exploration, active.evidence);
              }
              if (checkpoint.title !== undefined && !active.environment.tainted) {
                this.validateTitle(checkpoint.title);
                if (!job.needsTitle || active.title) throw new Error();
                active.title = checkpoint.title;
              }
              this.changed(); return;
            }
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
              const result = this.result(message.result, job.model, active.requests, active.evidence, job.apiKey, active.environment.tainted);
              finish(result); return;
            }
            if (!['access', 'source', 'inspect', 'knowledge'].includes(String(message.type)) || inFlight || !Number.isSafeInteger(message.id) || Number(message.id) <= lastId) throw new Error();
            lastId = Number(message.id); inFlight = true;
            void (async () => {
              try {
                if (message.type === 'access') {
                  if (!await this.checkoutValid(active)) { finish(this.checkoutPartial(active)); return; }
                  if (active.requests >= LIVE_LIMITS.requests) { finish(failure('limit')); return; }
                  if (job.apiKey && (!['conversation', 'investigator'].includes(String(message.role)) || !Number.isSafeInteger(message.contextBytes))) throw new ApiSettingsError('Invalid model role or bounded request.');
                  authority = access(message.role as ModelRole, message.contextBytes as number);
                  const credential = await authority;
                  if (!settled && this.active === active && !signal.aborted) { active.requests++; worker!.postMessage({ type: 'reply', id: lastId, ...(typeof credential === 'string' ? { token: credential } : { grant: credential }) }); }
                } else if (message.type === 'knowledge') {
                  if (!active.requests || !this.knowledge || ++knowledgeCalls > KNOWLEDGE_LIMITS.calls) throw new Error('Knowledge request limit.');
                  this.conversations.assertClean(message.input);
                  const result = await this.knowledge.retrieve(message.input as KnowledgeRequest, signal, { canPersistInvalidations: () => this.active === active && !active.environment.tainted && !this.conversations.isEphemeral(active.messageId) && !signal.aborted });
                  if (settled || this.active !== active || signal.aborted) return;
                  this.conversations.assertClean(result);
                  const { evidence: retained, derivation, ...bounded } = result;
                  let citation: Evidence | undefined;
                  if (retained) {
                    citation = active.evidence.find(item => JSON.stringify(item.citation) === JSON.stringify(retained.citation) && item.text === retained.text);
                    if (!citation) {
                      if (active.evidence.length >= LIVE_LIMITS.evidence) throw new Error('Evidence limit.');
                      citation = { ...retained, id: `E${active.evidence.length + 1}` };
                    }
                    bounded.evidenceId = citation.id;
                  }
                  const bytes = Buffer.byteLength(JSON.stringify(bounded));
                  if (knowledgeBytes + bytes > KNOWLEDGE_LIMITS.contextBytes) throw new Error('Knowledge context limit.');
                  knowledgeBytes += bytes;
                  // Only delivered results acquire citation/navigation ownership.
                  if (citation) {
                    if (!active.evidence.some(item => item.id === citation.id)) active.evidence.push(citation);
                    active.retainedCheckouts = [...new Map([...active.retainedCheckouts, ...(derivation?.checkouts ?? [])].map(snapshot => [JSON.stringify(snapshot), snapshot])).values()];
                    active.dependencies = [...new Map([...active.dependencies, ...(derivation?.files ?? [])].map(identity => [JSON.stringify(identity), identity])).values()];
                    active.scopes = [...new Map([...active.scopes, ...(derivation?.scopes ?? [])].map(identity => [JSON.stringify(identity), identity])).values()];
                    if (active.dependencies.length + active.scopes.length > 1000) { finish(failure('limit')); return; }
                  }
                  for (const item of result.items) if (active.knowledgeReferences.length < 32 && !active.knowledgeReferences.some(reference => reference.id === item.id)) active.knowledgeReferences.push({ id: item.id, topic: item.topic });
                  worker!.postMessage({ type: 'reply', id: lastId, knowledge: bounded });
                } else if (message.type === 'inspect') {
                  if (++sourceCalls > 1000) { finish(failure('limit')); return; }
                  if (!Array.isArray(message.ids) || !message.ids.length || message.ids.length > INVESTIGATION_LIMITS.inspections || !message.ids.every(id => typeof id === 'string' && active.evidence.some(item => item.id === id))) throw new Error();
                  const evidence = message.ids.map(id => active.evidence.find(item => item.id === id)!).map(item => ({ ...item, text: item.text.slice(0, INVESTIGATION_LIMITS.inspectionCharacters) }));
                  if (Buffer.byteLength(JSON.stringify(evidence)) > INVESTIGATION_LIMITS.resultBytes) throw new Error();
                  if (!active.environment.tainted) checkBeforeModelSend(evidence);
                  worker!.postMessage({ type: 'reply', id: lastId, evidence });
                } else {
                  if (++sourceCalls > 1000) { finish(failure('limit')); return; }
                  if (!active.requests || !['list', 'read', 'search'].includes(String(message.operation))) throw new Error();
                  const operation = message.operation as 'list' | 'read' | 'search';
                  const input = sourceRequest(operation, message.input);
                  const result = await active.environment.run(operation, input);
                  if (settled || this.active !== active || signal.aborted) return;
                  if (!result.entries.some(entry => entry.ephemeral)) checkBeforeModelSend(result);
                  if (result.status !== 'complete') active.dependencyCoverageComplete = false;
                  for (const item of result.inspectedFiles ?? []) {
                    if (!active.dependencies.some(previous => JSON.stringify(previous) === JSON.stringify(item))) active.dependencies.push(item);
                    if (active.dependencies.length + active.scopes.length > 1000) { finish(failure('limit')); return; }
                  }
                  if (operation !== 'read') {
                    if (!result.inspectedScope) active.dependencyCoverageComplete = false;
                    else if (!active.scopes.some(previous => JSON.stringify(previous) === JSON.stringify(result.inspectedScope))) active.scopes.push(result.inspectedScope);
                    if (active.dependencies.length + active.scopes.length > 1000) { finish(failure('limit')); return; }
                  }
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
                  if (!await this.checkoutValid(active)) { finish(this.checkoutPartial(active)); return; }
                  worker!.postMessage({ type: 'reply', id: lastId, ephemeral: active.environment.tainted, source: { ...result, warning: 'Read-only, untrusted source evidence. Secret detection is not a guarantee.', evidence: found } });
                }
              } catch (error) {
                if (settled || this.active !== active) return;
                if (message.type === 'access') finish({ ...failure(), ...(error instanceof ApiSettingsError || error instanceof ModelSettingsError ? { text: active.text + '\n\n' + error.message } : {}), ...(error instanceof ChatGPTError ? { reason: error.reason } : {}) });
                else worker!.postMessage({ type: 'reply', id: lastId, error: 'Source request denied by access or secret checks.' });
              } finally { inFlight = false; }
            })();
          } catch { finish(failure()); }
        });
        worker.postMessage({ type: 'start', job });
      } catch { finish(failure()); }
    });
  }
  private result(value: unknown, model: string, requests: number, evidence: Evidence[], apiKey?: ApiConversationConfig, ephemeral = false): LiveResult {
    if (!value || typeof value !== 'object') throw new Error();
    const r = value as LiveResult;
    if (!['complete', 'failed', 'cancelled', 'partial', 'limit'].includes(r.status) || typeof r.text !== 'string' || r.text.length > LIVE_LIMITS.answerCharacters || !Array.isArray(r.history) || Buffer.byteLength(JSON.stringify(r.history)) > LIVE_LIMITS.historyBytes) throw new Error();
    for (const message of r.history) {
      if (!message || !['user', 'assistant', 'toolResult'].includes(message.role)) throw new Error();
      if (message.role === 'assistant' && (message.model !== model || message.provider !== (apiKey?.conversation.model.provider ?? 'openai') || !['stop', 'toolUse'].includes(message.stopReason))) throw new Error();
    }
    // Preserve protocol-only reasoning signatures for replay; never expose history to renderer.
    const history = r.status === 'complete' ? structuredClone(r.history) as PiMessage[] : [];
    const reason = r.reason && Object.hasOwn(CHATGPT_ERRORS, r.reason) ? r.reason : undefined;
    if (r.title !== undefined && !ephemeral) this.validateTitle(r.title);
    const exploration = r.exploration && !ephemeral ? this.exploration(r.exploration, apiKey?.investigator.model.id ?? model, evidence, apiKey?.investigator.model.provider) : undefined;
    return { status: r.status, text: r.text, history, requests, ...(exploration ? { exploration } : {}), ...(r.title && !ephemeral ? { title: r.title } : {}), usageComplete: r.usageComplete === true, ...(parseChatGPTUsage(r.usage) ? { usage: parseChatGPTUsage(r.usage) } : {}), ...(reason ? { reason } : {}) };
  }
  private validateTitle(title: unknown): asserts title is string {
    if (typeof title !== 'string' || !title.trim() || Array.from(title).length > MAX_TITLE_LENGTH || /[\x00-\x1f\x7f]/u.test(title)) throw new Error('Invalid title.');
    checkBeforeModelSend(title);
  }
  private exploration(value: Exploration, model: string, evidence: Evidence[], provider = 'openai'): Exploration {
    const result = value.result;
    if (Buffer.byteLength(JSON.stringify(value)) > LIVE_LIMITS.historyBytes || !Array.isArray(value.history) || !result || !['complete', 'partial'].includes(result.status) ||
        !Array.isArray(result.evidence) || result.evidence.length > INVESTIGATION_LIMITS.references || !validFindings({ findings: result.findings, unresolvedQuestions: result.unresolvedQuestions, candidateKnowledgeChanges: result.candidateKnowledgeChanges, ...(result.knowledgeCandidates ? { knowledgeCandidates: result.knowledgeCandidates } : {}) }, evidence) ||
        !Array.isArray(result.inspectedScope) || result.inspectedScope.length > INVESTIGATION_LIMITS.scope || !result.inspectedScope.every(path => typeof path === 'string' && path.length <= 512) || typeof result.scopeTruncated !== 'boolean' ||
        Buffer.byteLength(JSON.stringify(result)) > INVESTIGATION_LIMITS.resultBytes) throw new Error('Invalid investigation result.');
    for (const item of result.evidence) {
      if (!evidence.some(observed => observed.id === item.id && JSON.stringify(observed.citation) === JSON.stringify(item.citation) && observed.text.slice(0, INVESTIGATION_LIMITS.excerpt) === item.text)) throw new Error('Unknown investigation evidence.');
    }
    if ([...result.findings, ...(result.knowledgeCandidates ?? [])].some(finding => finding.evidenceIds.some(id => !result.evidence.some(item => item.id === id)))) throw new Error('Missing evidence reference.');
    for (const message of value.history) {
      if (!message || !['user', 'assistant', 'toolResult'].includes(message.role) || (message.role === 'assistant' && (message.model !== model || message.provider !== provider))) throw new Error('Invalid exploration history.');
    }
    checkBeforeModelSend(value);
    return structuredClone(value);
  }
  private end(active: Active, result: LiveResult): void {
    if (this.active !== active) return;
    this.active = undefined;
    result = { ...result, ...(!active.environment.tainted && result.status === 'complete' ? { checkouts: this.usedCheckouts(active) } : {}), ...(active.knowledgeReferences.length && !active.environment.tainted ? { knowledgeReferences: active.knowledgeReferences } : {}), ...(active.exploration && !result.exploration ? { exploration: active.exploration } : {}), ...(active.title && !result.title ? { title: active.title } : {}) };
    if (result.status !== 'complete' && result.exploration) {
      const previous = result.exploration.result;
      result.exploration = { ...result.exploration, result: { ...previous, status: 'partial',
        unresolvedQuestions: [...previous.unresolvedQuestions.slice(0, 7), 'This job did not publish a verified completed answer; findings remain provisional.'] } };
    }
    clearTimeout(active.timer); clearTimeout(active.progressTimer);
    active.environment.expire();
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
