import { BUILD_CONSENT, reusableBuildKnowledge, type BuildScope, type BuildCoverage } from '../shared/build';
import { FOLDER_CONSENT } from '../shared/inventory';
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
import type { Resolutions } from './resolutions';
import type { Knowledge } from './knowledge';
import { KNOWLEDGE_LIMITS, type KnowledgeRequest } from '../shared/knowledge';
import type { SourceCheckout, SourceIdentity, SourceScope } from '../shared/sources';
import { sourceRequest } from './source-bridge';
import { checkBeforeModelSend } from './secret-check';
import { MAX_TITLE_LENGTH } from '../shared/contracts';
import { INVESTIGATION_LIMITS, INVESTIGATOR_MAX, validFindings, type InvestigatorTask, type Exploration } from '../shared/investigation';
import { LIVE_LIMITS, type Evidence, type LiveCheckpoint, type LiveParentMessage, type LiveResult, type LiveStart } from '../shared/live';

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
  investigators?: InvestigatorTask[];
  knowledgePublication?: LiveResult['knowledgePublication'];
  build?: BuildScope;
  contextNotice?: string;
  coverage?: BuildCoverage;
  buildGeneration?: string;
  reuseReceipts?: Map<string, ReturnType<Conversations['buildReceipts']>[number]>;
  sourceRoots: string[];
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
    private readonly spawn: () => LiveWorker, private readonly changed: () => void, private readonly apiSettings?: ApiSettings, private readonly knowledge?: Knowledge, private readonly resolutions?: Resolutions) { this.checkouts = new SourceCheckouts(sources, inventory); }

  build(names: string[], consent: string): void {
    if (consent !== BUILD_CONSENT) throw new LiveError('Explicit paid build consent is required.');
    const build = this.buildScope(names);
    this.start(null, `Build/refresh knowledge for: ${names.join(', ')}. ${BUILD_CONSENT}`, undefined, build);
  }
  private buildScope(names: string[]): BuildScope {
    if (!Array.isArray(names) || !names.length || names.length > INVESTIGATOR_MAX || new Set(names).size !== names.length) throw new LiveError('Select one to eight distinct repositories.');
    const snapshot = this.inventory.snapshot();
    return { repositories: names.map(name => {
      const repo = snapshot.repositories.find(repo => repo.name === name && repo.presence === 'present');
      const root = repo && snapshot.roots.filter(root => !root.revokedAt && root.consent === FOLDER_CONSENT && root.acceptedAt && (repo.path === root.path || repo.path.startsWith(root.path + '/'))).sort((a, b) => b.path.length - a.path.length)[0];
      if (!repo || !root) throw new LiveError('Selected repository is unavailable or lacks folder consent. Rescan and select again.');
      return { name: repo.name, path: repo.path, root: root.path, documentationRoots: [...repo.documentationRoots] };
    }) };
  }
  start(id: string | null, prompt: string, retryId?: string, build?: BuildScope): void {
    this.retrySaving();
    if (this.unsaved) throw new LiveError('Save the previous result before starting another conversation.');
    if (this.active) throw new LiveError('A conversation is already running.');
    if (retryId) {
      const target = this.conversations.retryTarget(retryId); id = target.conversationId; prompt = target.prompt; build = target.build;
      if (build && JSON.stringify(this.buildScope(build.repositories.map(repo => repo.name))) !== JSON.stringify(build)) throw new LiveError('Build scope changed. Select repositories and authorize a new build.');
    }
    try { this.conversations.assertClean({ prompt, build }); } catch { throw new LiveError('Message withheld by secret checks. Remove suspected credentials before sending.'); }
    let binding;
    try {
      if (id) this.conversations.binding(id); // Demos stay read-only.
      if (this.apiSettings?.route() === 'api-key') {
        const apiKey = this.apiSettings.conversationConfig();
        this.apiSettings!.assertApproved(apiKey.conversation); this.apiSettings!.assertApproved(apiKey.investigator);
        binding = structuredClone({ model: apiKey.conversation.model.id, registration: '', apiKey });
      } else {
        if (this.chatgpt.snapshot().activity !== 'idle') throw new LiveError('Finish or cancel the current ChatGPT operation first.');
        binding = this.chatgpt.conversationBinding();
        // Model changes do not silently transfer a saved ChatGPT transcript to
        // another account/registration. Existing reconnect isolation still applies.
        const registration = id ? this.conversations.chatgptRegistration(id) : undefined;
        if (registration && registration !== binding.registration) throw new ChatGPTError('authentication');
      }
    } catch (error) {
      if (error instanceof ChatGPTError || error instanceof ApiSettingsError || error instanceof LiveError) throw error;
      throw new LiveError('Local demonstrations are read-only. Start a new conversation.');
    }
    const maxInvestigators = this.conversations.maxInvestigators();
    // One immutable catalogue owns both persisted provenance and worker metadata.
    // Designating another folder during preparation cannot silently expand it.
    const snapshot = this.inventory.snapshot();
    const roots: LiveStart['roots'] = snapshot.roots.filter(root => !root.revokedAt && root.consent === FOLDER_CONSENT && root.acceptedAt).map(root => ({ path: root.path, repositories: snapshot.repositories.filter(repo => repo.presence === 'present' && (repo.path === root.path || repo.path.startsWith(root.path + '/'))).map(repo => ({ name: repo.name, path: repo.path })) }));
    const sourceRoots = roots.map(root => root.path);
    const job = this.conversations.beginLive(id, prompt, binding, retryId, build, sourceRoots);
    const controller = new AbortController();
    const environment = new EnvironmentPermissions(this.sources, controller.signal, () => this.conversations.markEphemeral(job.messageId), () => this.cancel(), this.changed, content => this.conversations.rememberEnvironment(content));
    const active: Active = { ...job, sourceRoots, apiKey: !!binding.apiKey, controller, environment, knowledgeReferences: [], checkouts: [], retainedCheckouts: [], text: '', evidence: [], dependencies: [], scopes: [], dependencyCoverageComplete: true, requests: 0 };
    if (build) {
      active.build = build; active.buildGeneration = this.knowledge?.generation();
      active.coverage = { repositories: build.repositories.map(repo => repo.name), reusedRepositories: [], reusedFrom: [], inspected: [], unsupported: [], failures: [], unresolved: [], truncated: false,
        notice: 'Bounded source coverage, not exhaustive architectural knowledge. Listed/read material is not proof of understood behavior. Unsupported and unvisited inputs, unresolved references and runtime behavior remain unknown.' };
    }
    this.active = active;
    active.timer = setTimeout(() => this.end(active, { status: 'limit', text: active.text + '\n\nTime limit reached. Retry explicitly when ready.', history: [], requests: active.requests, usageComplete: false }), LIVE_LIMITS.milliseconds);
    this.changed();
    void (async () => {
      let outcome: LiveResult | undefined;
      try {
        this.conversations.progressLive(active.messageId, '', 'Checking local checkout freshness — no model calls…');
        if (active.coverage) this.conversations.progressBuild(active.messageId, active.coverage);
        this.changed();
        await this.knowledge?.scan(active.controller.signal);
        active.checkouts = await this.checkouts.capture(active.controller.signal);
        const reusable: string[] = [];
        active.reuseReceipts = new Map();
        if (build) {
          const receipts = this.conversations.buildReceipts(active.buildGeneration ?? '');
          for (const repo of build.repositories) {
            const current = active.checkouts.find(checkout => checkout.folder === repo.root && checkout.repository?.name === repo.name);
            if (!current?.complete) continue;
            const receipt = receipts.find(receipt => receipt.scope.repositories.some(previous => JSON.stringify(previous) === JSON.stringify(repo)) && receipt.build?.repositories.includes(repo.name) && receipt.investigators?.some(task => task.scope === repo.name && task.knowledgePublication === 'published') && receipt.checkouts?.some(checkout => JSON.stringify(checkout) === JSON.stringify(current)));
            if (receipt?.checkouts?.length && await this.checkouts.fresh(receipt.checkouts, active.controller.signal)) {
              reusable.push(repo.name);
              active.reuseReceipts.set(repo.name, receipt);
            }
          }
        }
        const previous = this.conversations.resumeContext(job.conversationId);
        const historicalCurrent = await this.historicalCurrent(previous, active.controller.signal);
        if (!historicalCurrent) previous.history = [];
        // Historical citations are navigation identities, never this job's evidence.
        // Even unchanged historical text must acquire current evidence via retrieval.
        if (historicalCurrent) active.retainedCheckouts = previous.checkouts ?? [];
        if (id) active.contextNotice = historicalCurrent
          ? 'Historical context only: at most the latest completed question/answer (1024 characters each). Saved tool transcripts, summaries and citations are not current evidence; retrieve or revalidate sources.'
          : 'Historical context withheld: sources changed, were deleted, are unchecked or no longer permitted. Retrieve current knowledge or investigate fresh sources. Saved answers and citations are unchanged.';
        if (build) active.retainedCheckouts.push(...active.checkouts.filter(checkout => build.repositories.some(repo => checkout.folder === repo.root && checkout.repository?.name === repo.name)));
        if (this.active !== active) return;
        const work = async (access: (role?: ModelRole, bytes?: number) => Promise<string | ApiGrant>, signal: AbortSignal) => {
          signal.throwIfAborted();
          this.conversations.assertClean({ history: previous.history, roots });
          const scope = this.conversations.scope(job.conversationId)?.repositories
            .filter(repo => roots.some(root => root.path === repo.root && root.repositories.some(current => current.name === repo.name && current.path === repo.path)))
            .map(repo => repo.name);
          const { messageId: namingMessageId, ...naming } = this.conversations.naming(job.conversationId);
          if (id && naming.needsTitle) {
            // Naming has its own original-turn provenance; the latest turn's
            // freshness must not authorize an older revoked question.
            const origin = namingMessageId ? this.conversations.resumeContext(job.conversationId, namingMessageId) : undefined;
            if (!origin?.history.length || !await this.historicalCurrent(origin, signal)) {
              naming.needsTitle = false; delete naming.titlePrompt;
            } else active.retainedCheckouts = [...new Map([...active.retainedCheckouts, ...(origin.checkouts ?? [])].map(checkout => [JSON.stringify(checkout), checkout])).values()];
          }
          outcome = await this.run(active, { ...(binding.apiKey ? { apiKey: binding.apiKey } : {}), model: binding.model, maxInvestigators,
            ...(build ? { build: { ...build, reusable } } : {}), prompt: job.prompt, history: previous.history, roots, scope,
            ...naming }, access, signal);
          if (outcome.reason && !binding.apiKey) throw new ChatGPTError(outcome.reason);
        };
        if (binding.apiKey) await work((role, bytes) => this.apiSettings!.grant(binding.apiKey!, role!, bytes!, active.controller.signal), active.controller.signal);
        else await this.chatgpt.conversation(binding, active.controller.signal, work);
        if (this.active !== active || !outcome) return;
        if (outcome.investigators) active.investigators = outcome.investigators;
        if (outcome.status === 'complete') {
          const identitiesValid = await this.verify(active.evidence, active.controller.signal, active.environment);
          const citationsValid = [...outcome.text.matchAll(/\[(E\d+)\]/g)].every(match => active.evidence.some(evidence => evidence.id === match[1]));
          if (!identitiesValid || !citationsValid || !await this.checkoutValid(active)) outcome = { ...outcome, status: 'partial', history: [], text: outcome.text + '\n\nPartial: the checkout changed, became unavailable, or a citation could not be verified. Retry for current evidence.' };
        }
        const completedResults = outcome.investigators?.length
          ? outcome.investigators.filter(task => task.status === 'complete').map(task => ({ result: task.result!, task }))
          : [(outcome.exploration ?? active.exploration)?.result].filter(result => result !== undefined).map(result => ({ result, task: undefined }));
        if (this.knowledge && ['complete', 'partial'].includes(outcome.status) && !active.environment.tainted && !this.conversations.isEphemeral(active.messageId)) {
          let published = 0, withheld = 0;
          for (const { result, task } of completedResults) {
            const candidates = result.knowledgeCandidates;
            if (!candidates?.length) continue;
            try {
              await this.knowledge.publish({ owner: { conversationId: active.conversationId, messageId: active.messageId }, candidates,
                evidence: active.evidence, inspectedFiles: active.dependencies, inspectedScopes: active.scopes, checkouts: this.usedCheckouts(active), completed: active.dependencyCoverageComplete && result.status === 'complete' && !result.scopeTruncated,
                environmentExposed: active.environment.tainted, signal: active.controller.signal,
                assertPublishable: () => {
                  if (this.active !== active || active.environment.tainted || this.conversations.isEphemeral(active.messageId)) throw new Error('Knowledge publication revoked.');
                  this.conversations.assertClean({ outcome, exploration: active.exploration, evidence: active.evidence });
                } });
              published++;
              if (task) task.knowledgePublication = 'published';
            } catch {
              if (this.active !== active) return;
              withheld++;
              if (task) task.knowledgePublication = 'withheld';
            }
            if (this.active !== active) return;
            outcome.knowledgePublication = active.knowledgePublication = published && withheld ? 'partial' : published ? 'published' : 'withheld';
            if (active.investigators) this.conversations.progressInvestigators(active.messageId, active.investigators, active.evidence, active.knowledgePublication);
            this.changed();
          }
        }
        if (outcome.status === 'complete' && active.coverage && (active.coverage.truncated || active.coverage.failures.length || outcome.knowledgePublication === 'withheld' || outcome.knowledgePublication === 'partial')) outcome = { ...outcome, status: 'partial', history: [], text: outcome.text + '\n\nPartial build: some sources, references or publication checks did not complete. Review coverage and retry explicitly.' };
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
  /** A worker sees the root catalogue from start, and may hold uncheckpointed
   * excerpts. Stop the whole job rather than guessing which child is unaffected. */
  revokeFolderAccess(): void {
    if (this.active) this.end(this.active, { status: 'cancelled', text: this.active.text + '\n\nFolder access revoked. Active and queued work stopped. Local history is retained with revoked-source labels and excluded from future context. Data already transmitted to a provider cannot be recalled; incurred usage remains.', history: [], requests: this.active.requests, usageComplete: false });
  }
  discardPurgedResults(messageIds: string[]): void {
    if (this.unsaved && (messageIds.includes(this.unsaved.messageId) || !this.conversations.hasAttempt(this.unsaved.messageId))) this.unsaved = undefined;
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
  private associateAvailableRoots(active: Active): void {
    // Source/retrieval tools still use current global permissions. If a new grant
    // becomes available mid-job, record its possible contribution before release,
    // even if compaction later discards the returned provenance envelopes.
    const added = this.inventory.snapshot().roots.filter(root => !root.revokedAt && root.consent === FOLDER_CONSENT && root.acceptedAt && !active.sourceRoots.includes(root.path)).map(root => root.path);
    if (!added.length) return;
    this.conversations.associateRoots(active.messageId, added);
    active.sourceRoots = [...active.sourceRoots, ...added];
  }
  private accessValid(active: Active): boolean {
    const roots = this.inventory.snapshot().roots;
    return active.sourceRoots.every(path => roots.some(root => root.path === path && !root.revokedAt && root.consent === FOLDER_CONSENT && root.acceptedAt));
  }
  private async checkoutValid(active: Active): Promise<boolean> {
    if (!this.accessValid(active)) return false;
    const identities = this.checkoutIdentities(active);
    const snapshots = this.checkouts.select(identities, active.checkouts);
    return this.checkouts.covers(identities, snapshots) && await this.checkouts.fresh(this.usedCheckouts(active), active.controller.signal) && this.accessValid(active);
  }
  private checkoutPartial(active: Active, result?: LiveResult): LiveResult {
    return { ...(result ?? { requests: active.requests, usageComplete: false }), status: 'partial', history: [],
      text: (result?.text ?? active.text) + '\n\nPartial: the checkout changed during analysis or scan coverage was incomplete. No compatible snapshot was committed. Retry explicitly for fresh sources within a new job.' };
  }
  private async historicalCurrent(previous: ReturnType<Conversations['resumeContext']>, signal: AbortSignal): Promise<boolean> {
    return previous.provenanceComplete !== false && await this.verify(previous.evidence, signal) &&
      (!(previous.evidence.length || previous.sourceBacked || previous.checkouts?.length) ||
        !!previous.checkouts?.length && await this.checkouts.fresh(previous.checkouts, signal));
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
      let worker: LiveWorker | undefined, settled = false, inFlight = 0, lastId = 0, sourceCalls = 0;
      let operations = Promise.resolve();
      const reportedUsage = new Set<number>();
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
          if (!this.accessValid(active)) { this.revokeFolderAccess(); return; }
          try {
            if (!value || typeof value !== 'object') throw new Error();
            const message = value as Record<string, unknown>;
            if (message.type === 'checkpoint') {
              if (!message.checkpoint || typeof message.checkpoint !== 'object') throw new Error();
              const checkpoint = message.checkpoint as LiveCheckpoint;
              if (checkpoint.investigators && !active.environment.tainted) {
                active.investigators = this.tasks(checkpoint.investigators, active, job);
                this.conversations.progressInvestigators(active.messageId, active.investigators, active.evidence);
              }
              if (checkpoint.childExploration && !active.environment.tainted) {
                const { taskId, exploration } = checkpoint.childExploration;
                if (!active.investigators?.some(task => task.id === taskId && task.status === 'running')) throw new Error('Unknown child transcript owner.');
                const checked = this.exploration(exploration, job.apiKey?.investigator.model.id ?? job.model, active.evidence, job.apiKey?.investigator.model.provider);
                this.conversations.progressChildHistory(active.messageId, taskId, checked.history);
              }
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
              if (!Number.isSafeInteger(message.request) || Number(message.request) < 1 || Number(message.request) > active.requests || reportedUsage.has(Number(message.request))) throw new Error();
              reportedUsage.add(Number(message.request));
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
              if (!active.environment.tainted && (message.result as LiveResult).investigators) result.investigators = this.tasks((message.result as LiveResult).investigators!, active, job);
              finish(result); return;
            }
            if (!['access', 'source', 'inspect', 'knowledge'].includes(String(message.type)) || inFlight >= 32 || !Number.isSafeInteger(message.id) || Number(message.id) <= lastId) throw new Error();
            const requestId = lastId = Number(message.id); inFlight++;
            // Serialize authority/source mutations, not provider requests. Every reply owns its original ID.
            operations = operations.then(async () => {
              try {
                if (settled || this.active !== active || signal.aborted) return;
                if (message.type === 'source' || message.type === 'knowledge') this.associateAvailableRoots(active);
                if (message.type === 'access') {
                  if (!await this.checkoutValid(active)) { finish(this.checkoutPartial(active)); return; }
                  if (active.requests >= LIVE_LIMITS.requests) { finish(failure('limit')); return; }
                  if (job.apiKey && (!['conversation', 'investigator'].includes(String(message.role)) || !Number.isSafeInteger(message.contextBytes))) throw new ApiSettingsError('Invalid model role or bounded request.');
                  authority = access(message.role as ModelRole, message.contextBytes as number);
                  const credential = await authority;
                  if (!this.accessValid(active)) { this.revokeFolderAccess(); return; }
                  if (!settled && this.active === active && !signal.aborted && this.accessValid(active)) { active.requests++; worker!.postMessage({ type: 'reply', id: requestId, ...(typeof credential === 'string' ? { token: credential } : { grant: credential }) }); }
                } else if (message.type === 'knowledge') {
                  if ((!active.requests && !job.build) || !this.knowledge || ++knowledgeCalls > KNOWLEDGE_LIMITS.calls) throw new Error('Knowledge request limit.');
                  this.conversations.assertClean(message.input);
                  const retrieved = await this.knowledge.retrieve(message.input as KnowledgeRequest, signal, { canPersistInvalidations: () => this.active === active && !active.environment.tainted && !this.conversations.isEphemeral(active.messageId) && !signal.aborted });
                  let result = this.resolutions ? await this.resolutions.attach(retrieved, signal) : retrieved;
                  if (settled || this.active !== active || signal.aborted) return;
                  this.conversations.assertClean(result);
                  // Old leads remain locally inspectable, but cannot seed a model job
                  // with a different checkout baseline (including explicit refreshes).
                  // Withhold BEFORE delivery/ownership so fresh investigation remains possible.
                  if (result.items.length && !result.derivation?.checkouts.length || result.derivation?.checkouts.some(snapshot => !snapshot.complete || !this.checkouts.select([snapshot], active.checkouts)
                    .some(current => current.complete && current.contentIdentity === snapshot.contentIdentity))) {
                    result = { items: [], notice: 'Knowledge withheld: original source provenance does not match this job. Investigate fresh sources; no match is not proof of absence.' };
                  }
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
                  }
                  if (derivation) {
                    // Retain original fingerprints even for ordinary/stale leads without E citations.
                    // The current job baseline must never revive an older derivation.
                    active.retainedCheckouts = [...new Map([...active.retainedCheckouts, ...derivation.checkouts].map(snapshot => [JSON.stringify(snapshot), snapshot])).values()];
                    active.dependencies = [...new Map([...active.dependencies, ...(derivation?.files ?? [])].map(identity => [JSON.stringify(identity), identity])).values()];
                    active.scopes = [...new Map([...active.scopes, ...(derivation?.scopes ?? [])].map(identity => [JSON.stringify(identity), identity])).values()];
                    if (active.dependencies.length + active.scopes.length > 1000) { finish(failure('limit')); return; }
                  }
                  if (active.coverage && message.input && typeof message.input === 'object') {
                    const request = message.input as KnowledgeRequest;
                    if (request.operation === 'search' && request.scope && job.build?.reusable.includes(request.scope) && reusableBuildKnowledge(result)) {
                      if (!active.coverage.reusedRepositories.includes(request.scope)) {
                        active.coverage.reusedRepositories.push(request.scope);
                        const receipt = active.reuseReceipts?.get(request.scope);
                        if (receipt) active.coverage.reusedFrom.push({ repository: request.scope, ...receipt.owner });
                      }
                    }
                  }
                  if (active.coverage) this.conversations.progressBuild(active.messageId, active.coverage);
                  for (const item of result.items) if (active.knowledgeReferences.length < 32 && !active.knowledgeReferences.some(reference => reference.id === item.id)) active.knowledgeReferences.push({ id: item.id, topic: item.topic });
                  worker!.postMessage({ type: 'reply', id: requestId, knowledge: bounded });
                } else if (message.type === 'inspect') {
                  if (++sourceCalls > 1000) { finish(failure('limit')); return; }
                  if (!Array.isArray(message.ids) || !message.ids.length || message.ids.length > INVESTIGATION_LIMITS.inspections || !message.ids.every(id => typeof id === 'string' && active.evidence.some(item => item.id === id))) throw new Error();
                  const evidence = message.ids.map(id => active.evidence.find(item => item.id === id)!).map(item => ({ ...item, text: item.text.slice(0, INVESTIGATION_LIMITS.inspectionCharacters) }));
                  if (Buffer.byteLength(JSON.stringify(evidence)) > INVESTIGATION_LIMITS.resultBytes) throw new Error();
                  if (!active.environment.tainted) checkBeforeModelSend(evidence);
                  worker!.postMessage({ type: 'reply', id: requestId, evidence });
                } else {
                  if (++sourceCalls > 1000) { finish(failure('limit')); return; }
                  if (!active.requests || !['list', 'read', 'search'].includes(String(message.operation))) throw new Error();
                  const operation = message.operation as 'list' | 'read' | 'search';
                  const input = sourceRequest(operation, message.input);
                  const result = await active.environment.run(operation, input);
                  if (settled || this.active !== active || signal.aborted) return;
                  if (!result.entries.some(entry => entry.ephemeral)) checkBeforeModelSend(result);
                  if (active.coverage) {
                    if (active.coverage.inspected.length < 200) active.coverage.inspected.push({ operation, root: input.root, path: input.path, status: result.status }); else active.coverage.truncated = true;
                    for (const entry of result.entries) if (entry.reason) {
                      if (active.coverage.unsupported.length < 100) active.coverage.unsupported.push({ root: input.root, path: entry.path, reason: entry.reason }); else active.coverage.truncated = true;
                      // The shared reader can withhold an over-budget excerpt as an entry
                      // rather than truncating the outer operation. It is still a build gap.
                      if (entry.reason.includes('limit')) {
                        active.coverage.truncated = true; active.dependencyCoverageComplete = false;
                        if (active.coverage.failures.length < 100) active.coverage.failures.push(`${input.root}/${entry.path}: ${entry.reason}`);
                      }
                    }
                    if (result.status !== 'complete') {
                      if (active.coverage.failures.length < 100) active.coverage.failures.push(`${input.root}/${input.path}: ${result.reason ?? result.status}`);
                      active.coverage.truncated = true;
                    }
                  }
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
                  if (active.coverage) this.conversations.progressBuild(active.messageId, active.coverage);
                  if (!await this.checkoutValid(active)) { finish(this.checkoutPartial(active)); return; }
                  worker!.postMessage({ type: 'reply', id: requestId, ephemeral: active.environment.tainted, source: { ...result, warning: 'Read-only, untrusted source evidence. Secret detection is not a guarantee.', evidence: found } });
                }
              } catch (error) {
                if (settled || this.active !== active) return;
                if (message.type === 'access') finish({ ...failure(), ...(error instanceof ApiSettingsError || error instanceof ModelSettingsError ? { text: active.text + '\n\n' + error.message } : {}), ...(error instanceof ChatGPTError ? { reason: error.reason } : {}) });
                else {
                  if (active.coverage && active.coverage.failures.length < 100) active.coverage.failures.push('A source/retrieval request was denied by access or secret checks.');
                  worker!.postMessage({ type: 'reply', id: requestId, error: 'Source request denied by access or secret checks.' });
                }
              } finally { inFlight--; }
            });
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
  private tasks(value: InvestigatorTask[], active: Active, job: LiveStart): InvestigatorTask[] {
    if (!Array.isArray(value) || value.length > INVESTIGATOR_MAX || Buffer.byteLength(JSON.stringify(value)) > LIVE_LIMITS.historyBytes) throw new Error('Invalid investigator batch.');
    if (value.filter(task => task.status === 'running').length > (job.maxInvestigators ?? 3)) throw new Error('Investigator concurrency exceeded.');
    if (active.investigators && value.length !== active.investigators.length) throw new Error('Batch assignments are frozen.');
    for (const [index, task] of value.entries()) {
      if (!task || Object.keys(task).some(key => !['id', 'question', 'scope', 'status', 'result'].includes(key)) || task.id !== `T${index + 1}` || typeof task.question !== 'string' || !task.question.trim() || task.question.length > 8000 || typeof task.scope !== 'string' || !task.scope.trim() || task.scope.length > 512 || !['queued', 'running', 'complete', 'failed', 'cancelled'].includes(task.status)) throw new Error('Invalid task.');
      const previous = active.investigators?.[index];
      if (previous && (previous.question !== task.question || previous.scope !== task.scope ||
          ['complete', 'failed', 'cancelled'].includes(previous.status) && JSON.stringify(previous) !== JSON.stringify(task) ||
          previous.status === 'running' && task.status === 'queued')) throw new Error('Task authority cannot be revived or reassigned.');
      if (task.result) this.exploration({ history: [], result: task.result }, job.apiKey?.investigator.model.id ?? job.model, active.evidence, job.apiKey?.investigator.model.provider);
      if (task.status === 'complete' && task.result?.status !== 'complete') throw new Error('Missing completed findings.');
    }
    checkBeforeModelSend(value);
    return structuredClone(value);
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
    result = { ...result, ...(active.contextNotice ? { contextNotice: active.contextNotice } : {}), ...(!active.environment.tainted && active.investigators && !result.investigators ? { investigators: active.investigators } : {}), ...(!active.environment.tainted && result.status === 'complete' ? { checkouts: this.usedCheckouts(active), ...(active.knowledgeReferences.length ? { knowledgeProvenance: 'complete' as const } : {}) } : {}), ...(active.knowledgeReferences.length && !active.environment.tainted ? { knowledgeReferences: active.knowledgeReferences } : {}), ...(active.exploration && !result.exploration ? { exploration: active.exploration } : {}), ...(active.title && !result.title ? { title: active.title } : {}) };
    if (active.knowledgePublication && !result.knowledgePublication) result.knowledgePublication = active.knowledgePublication;
    if (active.coverage && !active.environment.tainted && !this.conversations.isEphemeral(active.messageId)) {
      active.coverage.unresolved = [...active.coverage.reusedRepositories.flatMap(name => active.reuseReceipts?.get(name)?.build?.unresolved.filter(question => question.startsWith(name + ':')).slice(0, 8) ?? []), ...(result.investigators ?? []).flatMap(task => (task.result?.unresolvedQuestions ?? [`${task.scope}: ${task.status}`]).map(question => `${task.scope}: ${question}`))].slice(0, 100);
      for (const name of active.coverage.repositories) if (!active.coverage.reusedRepositories.includes(name) && !result.investigators?.some(task => task.scope === name && task.status === 'complete')) {
        active.coverage.failures.push(`${name}: investigation did not complete (${result.status}).`);
      }
      if (!result.investigators?.length && !active.coverage.reusedRepositories.length) active.coverage.unresolved.push('No completed investigation. Selected sources remain unknown.');
      result.build = active.coverage; result.buildGeneration = active.buildGeneration;
    }
    if (result.investigators) result.investigators = result.investigators.map(task => ['running', 'queued'].includes(task.status) ? { ...task, status: 'cancelled' } : task);
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
