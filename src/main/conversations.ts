import { checkpointPurge } from './local-purge';
import { LocalCleanup } from './local-cleanup';
import { associatedMaterial, overlaps } from './source-ownership';
import type { BuildCoverage, BuildScope } from '../shared/build';
import { randomUUID } from 'node:crypto';
import { checkBeforeModelSend, environmentValues } from './secret-check';
import { EPHEMERAL_NOTICE } from '../shared/environment';
import type { Message as PiMessage } from '@earendil-works/pi-ai';
import type { SourceCheckout } from '../shared/sources';
import { INVESTIGATOR_DEFAULT, INVESTIGATOR_MAX, type InvestigatorTask, type Exploration } from '../shared/investigation';
import { LIVE_LIMITS, type ConversationBinding, type Evidence, type LiveResult } from '../shared/live';
import { DatabaseSync } from 'node:sqlite';
import { MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH, type ConversationSummary, type DemoJob, type Message, type MessageStatus, type Workspace } from '../shared/contracts';

// Immediate local fallback until the job supplies a valid model-derived title.
function firstPromptTitle(text: string): string {
  const characters = Array.from(text.replace(/\s+/gu, ' '));
  return characters.length <= MAX_TITLE_LENGTH ? characters.join('') : characters.slice(0, MAX_TITLE_LENGTH - 1).join('').trimEnd() + '…';
}

/** Durable user state only. Rebuildable repository knowledge does not belong here. */
export class Conversations {
  private readonly db: DatabaseSync;
  private closed = false;
  private readonly cleanup: LocalCleanup;
  private readonly ephemeral = new Map<string, Partial<Message>>();
  private readonly sensitiveValues = new Set<string>();

  rememberEnvironment(text: string): void {
    for (const value of environmentValues(text)) {
      // Low-information scalars are not secrets in isolation. Keep their full
      // assignment/file text, but do not poison application control metadata.
      if (!Number.isFinite(Number(value)) && !/^(?:true|false|null|undefined|none)$/i.test(value)) this.sensitiveValues.add(value);
    }
  }
  assertClean(material: unknown): void {
    checkBeforeModelSend(material);
    const inspect = (value: unknown): boolean => {
      if (typeof value === 'string') return [...this.sensitiveValues].some(secret => value.includes(secret));
      if (value && typeof value === 'object') return Object.values(value).some(inspect);
      return false;
    };
    if (inspect(material)) throw new Error('Known environment content withheld.');
  }

  constructor(path: string, private readonly revokedRoots: () => string[] = () => []) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA secure_delete = ON;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'complete', 'failed', 'cancelled'))
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const columns = this.db.prepare('PRAGMA table_info(conversations)').all().map(row => row.name);
    if (!columns.includes('sealed')) this.db.exec('ALTER TABLE conversations ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('binding')) this.db.exec('ALTER TABLE conversations ADD COLUMN binding TEXT');
    if (!columns.includes('chatgpt_registration')) this.db.exec('ALTER TABLE conversations ADD COLUMN chatgpt_registration TEXT');
    if (!columns.includes('scope')) this.db.exec('ALTER TABLE conversations ADD COLUMN scope TEXT');
    if (!columns.includes('model_title')) this.db.exec('ALTER TABLE conversations ADD COLUMN model_title INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`CREATE TABLE IF NOT EXISTS live_attempts (
      message_id TEXT PRIMARY KEY REFERENCES messages(id), user_id TEXT NOT NULL,
      prompt TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]', result TEXT
    );
    UPDATE live_attempts SET result = json_set(json_remove(COALESCE(result, '{}'), '$.activity'), '$.status', 'cancelled', '$.usageComplete', json('false'), '$.interrupted', json('true'))
      WHERE message_id IN (SELECT id FROM messages WHERE status = 'running') OR json_extract(result, '$.status') = 'running';
    UPDATE messages SET status = 'cancelled', text = CASE
      WHEN id IN (SELECT message_id FROM live_attempts)
      THEN text || char(10) || char(10) || 'Conversation interrupted. Retry explicitly when ready.'
      ELSE 'Demonstration interrupted. Send another message to try again.' END
      WHERE status = 'running';`);
    const attempts = this.db.prepare('PRAGMA table_info(live_attempts)').all().map(row => row.name);
    if (!attempts.includes('binding')) this.db.exec('ALTER TABLE live_attempts ADD COLUMN binding TEXT');
    if (!attempts.includes('ephemeral')) this.db.exec('ALTER TABLE live_attempts ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0');
    if (!attempts.includes('build_scope')) this.db.exec('ALTER TABLE live_attempts ADD COLUMN build_scope TEXT');
    if (!attempts.includes('exploration')) this.db.exec('ALTER TABLE live_attempts ADD COLUMN exploration TEXT');
    if (!attempts.includes('source_roots')) this.db.exec("ALTER TABLE live_attempts ADD COLUMN source_roots TEXT NOT NULL DEFAULT '[]'");
    this.db.exec('CREATE TABLE IF NOT EXISTS revoked_sources (path TEXT PRIMARY KEY)');
    // Earlier releases pinned one binding per conversation. Backfill original
    // attempt identities and saved build scopes before allowing model changes.
    this.db.exec(`UPDATE live_attempts SET binding = (SELECT c.binding FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = message_id) WHERE binding IS NULL;
      UPDATE conversations SET scope = (SELECT a.build_scope FROM live_attempts a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = conversations.id AND a.build_scope IS NOT NULL ORDER BY m.rowid DESC LIMIT 1) WHERE scope IS NULL;
      UPDATE conversations SET chatgpt_registration = COALESCE(
        (SELECT json_extract(a.binding, '$.registration') FROM live_attempts a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = conversations.id AND json_extract(a.binding, '$.apiKey') IS NULL ORDER BY m.rowid LIMIT 1),
        CASE WHEN json_extract(binding, '$.apiKey') IS NULL THEN json_extract(binding, '$.registration') END
      ) WHERE chatgpt_registration IS NULL;`);
    // Unknown legacy completion dates begin their retention window at migration,
    // never at epoch. This migration does not expire any durable state.
    if (!attempts.includes('ended_at')) this.db.exec('ALTER TABLE live_attempts ADD COLUMN ended_at TEXT');
    if (!attempts.includes('verbose_deleted_at')) this.db.exec('ALTER TABLE live_attempts ADD COLUMN verbose_deleted_at TEXT');
    if (!attempts.includes('source_roots_recorded')) this.db.exec('ALTER TABLE live_attempts ADD COLUMN source_roots_recorded INTEGER NOT NULL DEFAULT 0');
    if (!attempts.includes('ownership_uncertain')) this.db.exec('ALTER TABLE live_attempts ADD COLUMN ownership_uncertain INTEGER NOT NULL DEFAULT 0');
    this.db.prepare(`UPDATE live_attempts SET ended_at = ? WHERE ended_at IS NULL AND message_id IN (SELECT id FROM messages WHERE status != 'running')`).run(new Date().toISOString());
    this.cleanup = new LocalCleanup(this.db);
    // Interrupted child work is terminal, never resumed on restart.
    for (const row of this.db.prepare('SELECT message_id, result FROM live_attempts WHERE result IS NOT NULL').all()) {
      const result = JSON.parse(String(row.result));
      if (result.investigators?.some((task: InvestigatorTask) => ['running', 'queued'].includes(task.status)) || result.interrupted && result.investigators?.length) {
        for (const task of result.investigators as InvestigatorTask[]) {
          if (['running', 'queued'].includes(task.status)) task.status = 'cancelled';
          if (result.interrupted && task.result) task.result.status = 'partial';
        }
        this.db.prepare('UPDATE live_attempts SET result = ? WHERE message_id = ?').run(JSON.stringify(result), String(row.message_id));
      }
    }
    this.db.exec(`UPDATE live_attempts SET result = json_set(result, '$.investigation.status', 'partial'),
      exploration = json_set(exploration, '$.result.status', 'partial')
      WHERE json_extract(result, '$.status') = 'cancelled' AND json_extract(result, '$.investigation.status') = 'complete';`);
  }

  private withdrawn(): string[] {
    return [...new Set([...this.revokedRoots(), ...this.db.prepare('SELECT path FROM revoked_sources').all().map(row => String(row.path))])];
  }
  private associatedConversations(roots: string[]): string[] {
    if (!roots.length) return [];
    return [...new Set(this.db.prepare(`SELECT m.conversation_id, a.* FROM live_attempts a JOIN messages m ON m.id = a.message_id`).all().filter(row => {
      const grants = JSON.parse(String(row.source_roots)) as string[];
      const result = row.result ? JSON.parse(String(row.result)) : {};
      // Pre-#19 knowledge-only or sealed attempts may have discarded every source
      // envelope. Without a root catalogue their independence from a withdrawn
      // folder cannot be established. Retain/purge them conservatively.
      if (row.ownership_uncertain || !row.source_roots_recorded && !grants.length && (row.ephemeral || result.knowledgeReferences?.length)) return true;
      return grants.some(grant => roots.some(root => overlaps(root, grant))) ||
        ['history', 'evidence', 'result', 'exploration', 'build_scope'].some(key => row[key] && associatedMaterial(JSON.parse(String(row[key])), roots));
    }).map(row => String(row.conversation_id)))];
  }
  hasAttempt(messageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM live_attempts WHERE message_id = ?').get(messageId);
  }
  associateRoots(messageId: string, roots: string[]): void {
    const row = this.db.prepare('SELECT source_roots FROM live_attempts WHERE message_id = ?').get(messageId);
    if (!row) throw new Error('Attempt unavailable.');
    const recorded = JSON.parse(String(row.source_roots)) as string[];
    this.db.prepare('UPDATE live_attempts SET source_roots = ? WHERE message_id = ?').run(JSON.stringify([...new Set([...recorded, ...roots])]), messageId);
  }
  revokedSources(id: string): string[] {
    return this.withdrawn().filter(root => this.associatedConversations([root]).includes(id));
  }
  revoke(roots: string[]): void {
    this.transaction(() => { for (const root of roots) this.db.prepare('INSERT OR IGNORE INTO revoked_sources VALUES (?)').run(root); });
  }
  /** Whole associated conversations are removed: free-form prose cannot safely be
   * separated into source-owned fragments. This also removes their later turns. */
  purge(roots: string[]): string[] {
    const ids = this.associatedConversations(roots);
    const removed: string[] = [];
    this.transaction(() => {
      for (const id of ids) {
        const messages = this.db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(id);
        for (const message of messages) { removed.push(String(message.id)); this.ephemeral.delete(String(message.id)); this.db.prepare('DELETE FROM live_attempts WHERE message_id = ?').run(message.id!); }
        this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
        this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      }
    });
    checkpointPurge(this.db);
    return removed;
  }

  workspace(): Workspace {
    // Ownership envelopes are large; scan once per withdrawn root, not once per
    // conversation on every streaming workspace refresh.
    const revocations = new Map<string, string[]>();
    for (const root of this.withdrawn()) for (const id of this.associatedConversations([root])) {
      revocations.set(id, [...(revocations.get(id) ?? []), root]);
    }
    const conversations = this.db.prepare('SELECT id, title, binding, sealed, scope FROM conversations ORDER BY rowid').all().map(row => {
      const revokedSources = revocations.get(String(row.id)) ?? [];
      return {
      id: String(row.id), title: String(row.title), ...(revokedSources.length ? { revokedSources } : {}), ...(row.scope ? { scope: JSON.parse(String(row.scope)) as BuildScope } : {}), ...(row.sealed ? { sealed: true } : {}), ...(row.binding ? { kind: (JSON.parse(String(row.binding)) as ConversationBinding).apiKey ? 'api-key' as const : 'chatgpt' as const, model: (JSON.parse(String(row.binding)) as ConversationBinding).model } : {}),
      };
    }) as ConversationSummary[];
    const selectedId = this.db.prepare("SELECT value FROM settings WHERE key = 'selected'").get()?.value;
    const summary = conversations.find(conversation => conversation.id === selectedId);
    const messages = summary ? this.db.prepare(
      'SELECT id, role, text, status FROM messages WHERE conversation_id = ? ORDER BY rowid',
    ).all(summary.id) as unknown as Message[] : [];
    for (const message of messages) {
      const attempt = this.db.prepare('SELECT result, evidence, binding FROM live_attempts WHERE message_id = ?').get(message.id);
      if (attempt?.result) {
        const { checkouts: _checkouts, ...visible } = JSON.parse(String(attempt.result));
        Object.assign(message, visible, { evidence: JSON.parse(String(attempt.evidence)) });
      }
      if (attempt?.binding) {
        const binding = JSON.parse(String(attempt.binding)) as ConversationBinding;
        Object.assign(message, { model: binding.model, provider: binding.apiKey?.conversation.model.provider ?? 'ChatGPT' });
      }
      Object.assign(message, this.ephemeral.get(message.id));
    }
    const active = this.db.prepare("SELECT conversation_id FROM messages WHERE status = 'running'").get();
    return {
      conversations,
      sourceAccessVersion: JSON.stringify(this.withdrawn().sort()),
      selected: summary ? { ...summary, messages } : null,
      activeConversationId: active ? String(active.conversation_id) : null,
      maxInvestigators: this.maxInvestigators(),
    };
  }

  /** Explicit user deletion. Knowledge and annotations have independent lifetimes. */
  deleteConversation(id: string): void {
    if (this.workspace().activeConversationId) throw new Error('Finish active work before deletion.');
    this.requireConversation(id);
    const messages = this.db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(id);
    this.cleanup.run(() => {
      for (const message of messages) this.db.prepare('DELETE FROM live_attempts WHERE message_id = ?').run(message.id!);
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      this.db.prepare("DELETE FROM settings WHERE key = 'selected' AND value = ?").run(id);
    });
    for (const message of messages) this.ephemeral.delete(String(message.id));
  }

  private verboseDays(): number | null {
    const policy = this.db.prepare("SELECT value FROM settings WHERE key = 'verboseDays'").get()?.value;
    return policy === 'forever' ? null : Number(policy ?? 30);
  }
  retentionStatus() {
    return { verboseDays: this.verboseDays(),
      expiredAttempts: Number(this.db.prepare('SELECT COUNT(*) AS count FROM live_attempts WHERE verbose_deleted_at IS NOT NULL').get()!.count),
      eligibleAttempts: Number(this.db.prepare("SELECT COUNT(*) AS count FROM live_attempts a JOIN messages m ON m.id = a.message_id WHERE m.status != 'running' AND a.verbose_deleted_at IS NULL AND a.ended_at <= ?").get(this.expiryCutoff())!.count),
      ...this.cleanup.status() };
  }
  setVerboseDays(days: number | null): void {
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 3650)) throw new Error('Choose zero to 3650 days or keep forever.');
    this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('verboseDays', ?)").run(days === null ? 'forever' : String(days));
  }
  private expiryCutoff(): string {
    const days = this.verboseDays();
    return days === null ? '' : new Date(Date.now() - days * 86400000).toISOString();
  }
  recoverCleanup(): void { this.cleanup.recover(); }
  cleanupExpired(): void {
    if (this.workspace().activeConversationId) throw new Error('Finish active work before cleanup.');
    this.cleanup.recover();
    const cutoff = this.expiryCutoff();
    if (!this.db.prepare("SELECT 1 FROM live_attempts WHERE verbose_deleted_at IS NULL AND ended_at <= ?").get(cutoff)) return;
    this.cleanup.run(() => {
      // New attempts retain the immutable request-root catalogue. Legacy history
      // without that catalogue cannot be proven independent of future revocations
      // once its source envelopes expire: preserve conservative ownership, not text.
      this.db.prepare(`UPDATE live_attempts SET ownership_uncertain = CASE
        WHEN source_roots_recorded = 0 AND source_roots = '[]' AND (history != '[]' OR exploration IS NOT NULL) THEN 1 ELSE ownership_uncertain END,
        history = '[]', exploration = NULL, verbose_deleted_at = ?,
        result = json_set(COALESCE(result, '{}'), '$.verboseExpired', json('true'))
        WHERE verbose_deleted_at IS NULL AND ended_at <= ?`).run(new Date().toISOString(), cutoff);
    });
  }

  maxInvestigators(): number {
    return Number(this.db.prepare("SELECT value FROM settings WHERE key = 'maxInvestigators'").get()?.value ?? INVESTIGATOR_DEFAULT);
  }
  setMaxInvestigators(maximum: number): void {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > INVESTIGATOR_MAX) throw new Error('Choose one to eight concurrent investigators.');
    this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('maxInvestigators', ?)").run(String(maximum));
  }
  progressBuild(messageId: string, build: BuildCoverage): void {
    if (this.protect(messageId, { build })) return;
    this.db.prepare("UPDATE live_attempts SET result = json_patch(COALESCE(result, '{}'), ?) WHERE message_id = ?")
      .run(JSON.stringify({ build }), messageId);
  }
  progressInvestigators(messageId: string, investigators: InvestigatorTask[], evidence: Evidence[], knowledgePublication?: LiveResult['knowledgePublication']): void {
    if (this.protect(messageId, { investigators, evidence })) return;
    // A task checkpoint and its main-owned citation ledger survive or fail together.
    this.db.prepare("UPDATE live_attempts SET result = json_patch(COALESCE(result, '{}'), ?), evidence = ? WHERE message_id = ?")
      .run(JSON.stringify({ investigators, ...(knowledgePublication ? { knowledgePublication } : {}) }), JSON.stringify(evidence), messageId);
  }

  select(id: string): void {
    this.requireConversation(id);
    this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('selected', ?)").run(id);
  }

  begin(conversationId: string | null, text: string): DemoJob {
    if (!text.trim() || text.length > MAX_MESSAGE_LENGTH || text.includes('\0')) throw new Error('Invalid message.');
    if (conversationId !== null) this.requireConversation(conversationId);
    text = text.trim();
    if (this.workspace().activeConversationId) throw new Error('A demonstration is already running.');
    const messageId = randomUUID();
    this.transaction(() => {
      if (conversationId === null) {
        conversationId = randomUUID();
        const title = firstPromptTitle(text);
        this.db.prepare('INSERT INTO conversations(id, title) VALUES (?, ?)').run(conversationId, title);
        this.select(conversationId);
      }
      const insert = this.db.prepare('INSERT INTO messages(id, conversation_id, role, text, status) VALUES (?, ?, ?, ?, ?)');
      insert.run(randomUUID(), conversationId, 'user', text, 'complete');
      insert.run(messageId, conversationId, 'assistant', 'Starting local demonstration…', 'running');
    });
    return { messageId, text };
  }

  progress(messageId: string, text: string): void {
    this.db.prepare("UPDATE messages SET text = ? WHERE id = ? AND status = 'running'").run(text, messageId);
  }

  finish(messageId: string, status: Exclude<MessageStatus, 'running'>, text: string): void {
    this.db.prepare("UPDATE messages SET status = ?, text = ? WHERE id = ? AND status = 'running'").run(status, text, messageId);
  }

  binding(id: string): ConversationBinding {
    const row = this.db.prepare('SELECT binding FROM conversations WHERE id = ?').get(id);
    if (!row?.binding) throw new Error('Local demonstrations are read-only. Start a new ChatGPT conversation.');
    return JSON.parse(String(row.binding)) as ConversationBinding;
  }

  chatgptRegistration(id: string): string | undefined {
    const row = this.db.prepare('SELECT chatgpt_registration FROM conversations WHERE id = ?').get(id);
    return row?.chatgpt_registration ? String(row.chatgpt_registration) : undefined;
  }

  scope(id: string): BuildScope | undefined {
    const row = this.db.prepare('SELECT scope FROM conversations WHERE id = ?').get(id);
    return row?.scope ? JSON.parse(String(row.scope)) as BuildScope : undefined;
  }

  naming(id: string): { needsTitle: boolean; titlePrompt?: string; messageId?: string } {
    this.requireConversation(id);
    if (this.revokedSources(id).length) return { needsTitle: false };
    if (this.db.prepare('SELECT model_title FROM conversations WHERE id = ?').get(id)?.model_title) return { needsTitle: false };
    const first = this.db.prepare("SELECT id, text FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY rowid LIMIT 1").get(id);
    const attempt = first && this.db.prepare('SELECT message_id FROM live_attempts WHERE user_id = ? ORDER BY rowid LIMIT 1').get(first.id!);
    return { needsTitle: true, titlePrompt: String(first?.text ?? ''), ...(attempt ? { messageId: String(attempt.message_id) } : {}) };
  }

  liveContext(id: string): { history: PiMessage[]; evidence: Evidence[]; checkouts?: SourceCheckout[]; sourceBacked?: boolean } {
    this.binding(id);
    if (this.revokedSources(id).length) return { history: [], evidence: [], sourceBacked: true };
    if (this.db.prepare('SELECT sealed FROM conversations WHERE id = ?').get(id)?.sealed) return { history: [], evidence: [] };
    const row = this.db.prepare(`SELECT a.history, a.evidence, a.result FROM live_attempts a JOIN messages m ON m.id = a.message_id
      WHERE m.conversation_id = ? AND m.status = 'complete' ORDER BY m.rowid DESC LIMIT 1`).get(id);
    if (!row) return { history: [], evidence: [] };
    const result = row.result ? JSON.parse(String(row.result)) : {};
    return { history: JSON.parse(String(row.history)), evidence: JSON.parse(String(row.evidence)),
      ...(result.checkouts ? { checkouts: result.checkouts } : {}), ...(result.investigation?.inspectedScope?.length ? { sourceBacked: true } : {}) };
  }

  /** One bounded public turn, not saved protocol/tool/subagent transcripts. The
   * supervisor must freshness/access-check its provenance before sending it.
   * An explicit attempt ID is used only to check original-question naming;
   * incomplete answer text from that lookup must never be sent as context. */
  resumeContext(id: string, messageId?: string): ReturnType<Conversations['liveContext']> {
    this.binding(id);
    if (this.revokedSources(id).length) return { history: [], evidence: [], sourceBacked: true };
    if (this.db.prepare('SELECT sealed FROM conversations WHERE id = ?').get(id)?.sealed) return { history: [], evidence: [] };
    const row = this.db.prepare(`SELECT substr(a.prompt, 1, 1024) AS prompt, substr(m.text, 1, 1024) AS answer, a.evidence,
      json_extract(a.result, '$.checkouts') AS checkouts,
      json_extract(a.result, '$.investigation.inspectedScope') AS inspected
      FROM live_attempts a JOIN messages m ON m.id = a.message_id
      WHERE m.conversation_id = ? AND (m.status = 'complete' OR m.id = ?) AND (? IS NULL OR m.id = ?) ORDER BY m.rowid DESC LIMIT 1`).get(id, messageId ?? null, messageId ?? null, messageId ?? null);
    if (!row) return { history: [], evidence: [] };
    return { history: [{ role: 'user', timestamp: 0, content: 'Historical conversation context only — NOT implementation evidence. Only the latest completed turn is included, bounded to 1024 characters per field; older constraints/details may be omitted. Ask for clarification if needed. Historical E IDs belong to that answer, not this job. Retrieve current knowledge or delegate revalidation before making implementation claims.\n' + JSON.stringify({ question: String(row.prompt), historicalAnswer: String(row.answer) }) }],
      evidence: JSON.parse(String(row.evidence)), ...(row.checkouts ? { checkouts: JSON.parse(String(row.checkouts)) } : {}), ...(row.inspected && JSON.parse(String(row.inspected)).length ? { sourceBacked: true } : {}) };
  }

  beginLive(id: string | null, prompt: string, binding: ConversationBinding, retryId?: string, build?: BuildScope, sourceRoots: string[] = []): { conversationId: string; messageId: string; prompt: string } {
    if (this.workspace().activeConversationId) throw new Error('A conversation is already running.');
    let userId: string = randomUUID();
    if (retryId) {
      const previous = this.db.prepare(`SELECT m.conversation_id, m.status, a.prompt, a.user_id FROM messages m
        JOIN live_attempts a ON a.message_id = m.id WHERE m.id = ?`).get(retryId);
      if (!previous || previous.status === 'complete' || previous.status === 'running') throw new Error('Attempt cannot be retried.');
      id = String(previous.conversation_id);
      if (this.revokedSources(id).length) throw new Error('Revoked-source history cannot be retried. Start a fresh question.');
      const last = this.db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get(id);
      if (last?.id !== retryId) throw new Error('Only the latest incomplete attempt can be retried.');
      prompt = String(previous.prompt); userId = String(previous.user_id);
    }
    if (id && this.db.prepare('SELECT sealed FROM conversations WHERE id = ?').get(id)?.sealed) throw new Error('Ephemeral investigation is sealed. Start a new conversation.');
    if (!prompt.trim() || prompt.length > MAX_MESSAGE_LENGTH || prompt.includes('\0')) throw new Error('Invalid message.');
    this.assertClean(prompt);
    if (id) this.binding(id); // Demonstrations cannot acquire live authority.
    const messageId = randomUUID();
    this.transaction(() => {
      if (!id) {
        id = randomUUID();
        this.db.prepare('INSERT INTO conversations(id, title, binding) VALUES (?, ?, ?)').run(id, firstPromptTitle(prompt), JSON.stringify(binding));
      }
      this.db.prepare('UPDATE conversations SET binding = ?, scope = COALESCE(?, scope), chatgpt_registration = COALESCE(chatgpt_registration, ?) WHERE id = ?').run(JSON.stringify(binding), build ? JSON.stringify(build) : null, binding.apiKey ? null : binding.registration, id);
      this.select(id);
      const insert = this.db.prepare('INSERT INTO messages(id, conversation_id, role, text, status) VALUES (?, ?, ?, ?, ?)');
      if (!retryId) insert.run(userId, id, 'user', prompt.trim(), 'complete');
      insert.run(messageId, id, 'assistant', '', 'running');
      this.db.prepare('INSERT INTO live_attempts(message_id, user_id, prompt, build_scope, binding, source_roots, source_roots_recorded) VALUES (?, ?, ?, ?, ?, ?, 1)').run(messageId, userId, prompt.trim(), build ? JSON.stringify(build) : null, JSON.stringify(binding), JSON.stringify(sourceRoots));
    });
    return { conversationId: id!, messageId, prompt: prompt.trim() };
  }

  retryTarget(messageId: string): { conversationId: string; prompt: string; build?: BuildScope } {
    const row = this.db.prepare('SELECT m.conversation_id, a.prompt, a.build_scope FROM live_attempts a JOIN messages m ON m.id = a.message_id WHERE m.id = ?').get(messageId);
    if (!row) throw new Error('Attempt not found.');
    return { conversationId: String(row.conversation_id), prompt: String(row.prompt), ...(row.build_scope ? { build: JSON.parse(String(row.build_scope)) as BuildScope } : {}) };
  }

  /** A receipt is only a reuse hint; caller must also check current knowledge and checkout identities. */
  buildReceipts(generation: string): (LiveResult & { scope: BuildScope; owner: { conversationId: string; messageId: string } })[] {
    return this.db.prepare("SELECT a.result, a.build_scope, a.message_id, m.conversation_id FROM live_attempts a JOIN messages m ON m.id = a.message_id WHERE json_extract(a.result, '$.status') = 'complete' AND json_extract(a.result, '$.buildGeneration') = ? AND a.build_scope IS NOT NULL ORDER BY a.rowid DESC LIMIT 100").all(generation)
      .map(row => ({ ...JSON.parse(String(row.result)) as LiveResult, scope: JSON.parse(String(row.build_scope)) as BuildScope, owner: { conversationId: String(row.conversation_id), messageId: String(row.message_id) } }));
  }

  /** Commit the safe marker BEFORE releasing any actual environment contents. */
  markEphemeral(messageId: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE conversations SET sealed = 1 WHERE id = (SELECT conversation_id FROM messages WHERE id = ?)').run(messageId);
      this.db.prepare("UPDATE messages SET text = ? WHERE id = ?").run(EPHEMERAL_NOTICE, messageId);
      this.db.prepare("UPDATE live_attempts SET ephemeral = 1, history = '[]', evidence = '[]', exploration = NULL, result = ? WHERE message_id = ?")
        .run(JSON.stringify({ status: 'running', ephemeral: true, text: EPHEMERAL_NOTICE }), messageId);
    });
  }

  isEphemeral(messageId: string): boolean {
    return !!this.db.prepare('SELECT ephemeral FROM live_attempts WHERE message_id = ?').get(messageId)?.ephemeral;
  }

  private protect(messageId: string, material: unknown): boolean {
    if (this.db.prepare('SELECT ephemeral FROM live_attempts WHERE message_id = ?').get(messageId)?.ephemeral) return true;
    try { this.assertClean(material); return false; }
    catch { this.markEphemeral(messageId); return true; }
  }

  progressLive(messageId: string, text: string, activity: string, reported?: Pick<LiveResult, 'usage' | 'requests' | 'usageComplete'>): void {
    if (!this.db.prepare('SELECT 1 FROM live_attempts WHERE message_id = ?').get(messageId)) return;
    if (this.protect(messageId, { text, activity, reported })) {
      this.ephemeral.set(messageId, { text, activity, ...reported, ephemeral: true });
      return;
    }
    this.transaction(() => {
      this.progress(messageId, text);
      this.db.prepare("UPDATE live_attempts SET result = json_patch(COALESCE(result, '{}'), ?) WHERE message_id = ?").run(JSON.stringify({ status: 'running', activity, ...reported }), messageId);
    });
  }

  exploration(messageId: string): Exploration | undefined {
    const row = this.db.prepare('SELECT exploration FROM live_attempts WHERE message_id = ?').get(messageId);
    return row?.exploration ? JSON.parse(String(row.exploration)) as Exploration : undefined;
  }

  progressExploration(messageId: string, exploration: Exploration, evidence: Evidence[]): void {
    const row = this.db.prepare('SELECT verbose_deleted_at FROM live_attempts WHERE message_id = ?').get(messageId);
    if (!row || row.verbose_deleted_at) return;
    if (this.protect(messageId, { exploration, evidence })) return;
    this.db.prepare(`UPDATE live_attempts SET exploration = ?, evidence = ?, result = json_patch(COALESCE(result, '{}'), ?)
      WHERE message_id = ?`).run(JSON.stringify(exploration), JSON.stringify(evidence), JSON.stringify({ investigation: exploration.result }), messageId);
  }

  finishLive(messageId: string, result: LiveResult, evidence: Evidence[]): void {
    if (!this.db.prepare('SELECT 1 FROM live_attempts WHERE message_id = ?').get(messageId)) return; // Purged attempts never return via late/save-retry events.
    if (this.protect(messageId, { result, evidence })) {
      const status = result.status;
      this.ephemeral.set(messageId, { text: result.text, status, ephemeral: true, requests: result.requests, usage: result.usage, usageComplete: result.usageComplete, activity: undefined });
      result = { status, text: EPHEMERAL_NOTICE, history: [], requests: result.requests, usage: result.usage, usageComplete: result.usageComplete };
      evidence = [];
    }
    // Expired protocol history is never resurrected by a delayed terminal save.
    const expired = !!this.db.prepare('SELECT verbose_deleted_at FROM live_attempts WHERE message_id = ?').get(messageId)?.verbose_deleted_at;
    const history = JSON.stringify(expired ? [] : result.history);
    if (Buffer.byteLength(history) > LIVE_LIMITS.historyBytes) throw new Error('History exceeds the local limit.');
    const { history: _history, reason: _reason, exploration, title: _title, ...savedResult } = result;
    const ephemeral = !!this.db.prepare('SELECT ephemeral FROM live_attempts WHERE message_id = ?').get(messageId)?.ephemeral;
    this.transaction(() => {
      if (result.title) this.db.prepare(`UPDATE conversations SET title = ?, model_title = 1 WHERE model_title = 0
        AND id = (SELECT conversation_id FROM messages WHERE id = ?)`).run(result.title, messageId);
      this.finish(messageId, result.status === 'partial' || result.status === 'limit' ? 'failed' : result.status, result.text);
      this.db.prepare('UPDATE live_attempts SET history = ?, evidence = ?, result = ?, exploration = ?, ended_at = COALESCE(ended_at, ?) WHERE message_id = ?')
        .run(result.status === 'complete' ? history : '[]', JSON.stringify(evidence), JSON.stringify({ ...savedResult, ...(ephemeral ? { ephemeral: true } : {}), ...(expired ? { verboseExpired: true } : {}), ...(exploration ? { investigation: exploration.result } : {}) }), exploration && !expired ? JSON.stringify(exploration) : null, new Date().toISOString(), messageId);
    });
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private requireConversation(id: string): void {
    if (!this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(id)) {
      throw new Error('Conversation not found.');
    }
  }

  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
