import { randomUUID } from 'node:crypto';
import { checkBeforeModelSend, environmentValues } from './secret-check';
import { EPHEMERAL_NOTICE } from '../shared/environment';
import type { Message as PiMessage } from '@earendil-works/pi-ai';
import type { SourceCheckout } from '../shared/sources';
import type { Exploration } from '../shared/investigation';
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

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
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
    if (!columns.includes('model_title')) this.db.exec('ALTER TABLE conversations ADD COLUMN model_title INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`CREATE TABLE IF NOT EXISTS live_attempts (
      message_id TEXT PRIMARY KEY REFERENCES messages(id), user_id TEXT NOT NULL,
      prompt TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]', result TEXT
    );
    UPDATE messages SET status = 'cancelled', text = CASE
      WHEN id IN (SELECT message_id FROM live_attempts)
      THEN text || char(10) || char(10) || 'Conversation interrupted. Retry explicitly when ready.'
      ELSE 'Demonstration interrupted. Send another message to try again.' END
      WHERE status = 'running';
    UPDATE live_attempts SET result = json_set(json_remove(result, '$.activity'), '$.status', 'cancelled', '$.usageComplete', json('false'))
      WHERE json_extract(result, '$.status') = 'running';`);
    const attempts = this.db.prepare('PRAGMA table_info(live_attempts)').all().map(row => row.name);
    if (!attempts.includes('ephemeral')) this.db.exec('ALTER TABLE live_attempts ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0');
    if (!attempts.includes('exploration')) this.db.exec('ALTER TABLE live_attempts ADD COLUMN exploration TEXT');
    this.db.exec(`UPDATE live_attempts SET result = json_set(result, '$.investigation.status', 'partial'),
      exploration = json_set(exploration, '$.result.status', 'partial')
      WHERE json_extract(result, '$.status') = 'cancelled' AND json_extract(result, '$.investigation.status') = 'complete';`);
  }

  workspace(): Workspace {
    const conversations = this.db.prepare('SELECT id, title, binding, sealed FROM conversations ORDER BY rowid').all().map(row => ({
      id: String(row.id), title: String(row.title), ...(row.sealed ? { sealed: true } : {}), ...(row.binding ? { kind: (JSON.parse(String(row.binding)) as ConversationBinding).apiKey ? 'api-key' as const : 'chatgpt' as const, model: (JSON.parse(String(row.binding)) as ConversationBinding).model } : {}),
    })) as ConversationSummary[];
    const selectedId = this.db.prepare("SELECT value FROM settings WHERE key = 'selected'").get()?.value;
    const summary = conversations.find(conversation => conversation.id === selectedId);
    const messages = summary ? this.db.prepare(
      'SELECT id, role, text, status FROM messages WHERE conversation_id = ? ORDER BY rowid',
    ).all(summary.id) as unknown as Message[] : [];
    for (const message of messages) {
      const attempt = this.db.prepare('SELECT result, evidence FROM live_attempts WHERE message_id = ?').get(message.id);
      if (attempt?.result) {
        const { checkouts: _checkouts, ...visible } = JSON.parse(String(attempt.result));
        Object.assign(message, visible, { evidence: JSON.parse(String(attempt.evidence)) });
      }
      Object.assign(message, this.ephemeral.get(message.id));
    }
    const active = this.db.prepare("SELECT conversation_id FROM messages WHERE status = 'running'").get();
    return {
      conversations,
      selected: summary ? { ...summary, messages } : null,
      activeConversationId: active ? String(active.conversation_id) : null,
    };
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

  naming(id: string): { needsTitle: boolean; titlePrompt?: string } {
    this.requireConversation(id);
    if (this.db.prepare('SELECT model_title FROM conversations WHERE id = ?').get(id)?.model_title) return { needsTitle: false };
    const first = this.db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY rowid LIMIT 1").get(id);
    return { needsTitle: true, titlePrompt: String(first?.text ?? '') };
  }

  liveContext(id: string): { history: PiMessage[]; evidence: Evidence[]; checkouts?: SourceCheckout[]; sourceBacked?: boolean } {
    this.binding(id);
    if (this.db.prepare('SELECT sealed FROM conversations WHERE id = ?').get(id)?.sealed) return { history: [], evidence: [] };
    const row = this.db.prepare(`SELECT a.history, a.evidence, a.result FROM live_attempts a JOIN messages m ON m.id = a.message_id
      WHERE m.conversation_id = ? AND m.status = 'complete' ORDER BY m.rowid DESC LIMIT 1`).get(id);
    if (!row) return { history: [], evidence: [] };
    const result = row.result ? JSON.parse(String(row.result)) : {};
    return { history: JSON.parse(String(row.history)), evidence: JSON.parse(String(row.evidence)),
      ...(result.checkouts ? { checkouts: result.checkouts } : {}), ...(result.investigation?.inspectedScope?.length ? { sourceBacked: true } : {}) };
  }

  beginLive(id: string | null, prompt: string, binding: ConversationBinding, retryId?: string): { conversationId: string; messageId: string; prompt: string } {
    if (this.workspace().activeConversationId) throw new Error('A conversation is already running.');
    let userId: string = randomUUID();
    if (retryId) {
      const previous = this.db.prepare(`SELECT m.conversation_id, m.status, a.prompt, a.user_id FROM messages m
        JOIN live_attempts a ON a.message_id = m.id WHERE m.id = ?`).get(retryId);
      if (!previous || previous.status === 'complete' || previous.status === 'running') throw new Error('Attempt cannot be retried.');
      id = String(previous.conversation_id);
      const last = this.db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get(id);
      if (last?.id !== retryId) throw new Error('Only the latest incomplete attempt can be retried.');
      prompt = String(previous.prompt); userId = String(previous.user_id);
    }
    if (id && this.db.prepare('SELECT sealed FROM conversations WHERE id = ?').get(id)?.sealed) throw new Error('Ephemeral investigation is sealed. Start a new conversation.');
    if (!prompt.trim() || prompt.length > MAX_MESSAGE_LENGTH || prompt.includes('\0')) throw new Error('Invalid message.');
    this.assertClean(prompt);
    if (id && JSON.stringify(this.binding(id)) !== JSON.stringify(binding)) throw new Error('Conversation identity changed.');
    const messageId = randomUUID();
    this.transaction(() => {
      if (!id) {
        id = randomUUID();
        this.db.prepare('INSERT INTO conversations(id, title, binding) VALUES (?, ?, ?)').run(id, firstPromptTitle(prompt), JSON.stringify(binding));
      }
      this.select(id);
      const insert = this.db.prepare('INSERT INTO messages(id, conversation_id, role, text, status) VALUES (?, ?, ?, ?, ?)');
      if (!retryId) insert.run(userId, id, 'user', prompt.trim(), 'complete');
      insert.run(messageId, id, 'assistant', '', 'running');
      this.db.prepare('INSERT INTO live_attempts(message_id, user_id, prompt) VALUES (?, ?, ?)').run(messageId, userId, prompt.trim());
    });
    return { conversationId: id!, messageId, prompt: prompt.trim() };
  }

  retryTarget(messageId: string): { conversationId: string; prompt: string } {
    const row = this.db.prepare('SELECT m.conversation_id, a.prompt FROM live_attempts a JOIN messages m ON m.id = a.message_id WHERE m.id = ?').get(messageId);
    if (!row) throw new Error('Attempt not found.');
    return { conversationId: String(row.conversation_id), prompt: String(row.prompt) };
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
    if (this.protect(messageId, { exploration, evidence })) return;
    this.db.prepare(`UPDATE live_attempts SET exploration = ?, evidence = ?, result = json_patch(COALESCE(result, '{}'), ?)
      WHERE message_id = ?`).run(JSON.stringify(exploration), JSON.stringify(evidence), JSON.stringify({ investigation: exploration.result }), messageId);
  }

  finishLive(messageId: string, result: LiveResult, evidence: Evidence[]): void {
    if (this.protect(messageId, { result, evidence })) {
      const status = result.status;
      this.ephemeral.set(messageId, { text: result.text, status, ephemeral: true, requests: result.requests, usage: result.usage, usageComplete: result.usageComplete, activity: undefined });
      result = { status, text: EPHEMERAL_NOTICE, history: [], requests: result.requests, usage: result.usage, usageComplete: result.usageComplete };
      evidence = [];
    }
    const history = JSON.stringify(result.history);
    if (Buffer.byteLength(history) > LIVE_LIMITS.historyBytes) throw new Error('History exceeds the local limit.');
    const { history: _history, reason: _reason, exploration, title: _title, ...savedResult } = result;
    const ephemeral = !!this.db.prepare('SELECT ephemeral FROM live_attempts WHERE message_id = ?').get(messageId)?.ephemeral;
    this.transaction(() => {
      if (result.title) this.db.prepare(`UPDATE conversations SET title = ?, model_title = 1 WHERE model_title = 0
        AND id = (SELECT conversation_id FROM messages WHERE id = ?)`).run(result.title, messageId);
      this.finish(messageId, result.status === 'partial' || result.status === 'limit' ? 'failed' : result.status, result.text);
      this.db.prepare('UPDATE live_attempts SET history = ?, evidence = ?, result = ?, exploration = ? WHERE message_id = ?')
        .run(result.status === 'complete' ? history : '[]', JSON.stringify(evidence), JSON.stringify({ ...savedResult, ...(ephemeral ? { ephemeral: true } : {}), ...(exploration ? { investigation: exploration.result } : {}) }), exploration ? JSON.stringify(exploration) : null, messageId);
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
