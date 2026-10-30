import { randomUUID } from 'node:crypto';
import type { Message as PiMessage } from '@earendil-works/pi-ai';
import { LIVE_LIMITS, type ConversationBinding, type Evidence, type LiveResult } from '../shared/live';
import { DatabaseSync } from 'node:sqlite';
import { MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH, type ConversationSummary, type DemoJob, type Message, type MessageStatus, type Workspace } from '../shared/contracts';

// Temporary local excerpt; replace with approved model naming during live integration (#5).
function firstPromptTitle(text: string): string {
  const characters = Array.from(text.replace(/\s+/gu, ' '));
  return characters.length <= MAX_TITLE_LENGTH ? characters.join('') : characters.slice(0, MAX_TITLE_LENGTH - 1).join('').trimEnd() + '…';
}

/** Durable user state only. Rebuildable repository knowledge does not belong here. */
export class Conversations {
  private readonly db: DatabaseSync;
  private closed = false;

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
    if (!columns.includes('binding')) this.db.exec('ALTER TABLE conversations ADD COLUMN binding TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS live_attempts (
      message_id TEXT PRIMARY KEY REFERENCES messages(id), user_id TEXT NOT NULL,
      prompt TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]', result TEXT
    );
    UPDATE messages SET status = 'cancelled', text = CASE
      WHEN id IN (SELECT message_id FROM live_attempts)
      THEN text || char(10) || char(10) || 'ChatGPT conversation interrupted. Retry explicitly when ready.'
      ELSE 'Demonstration interrupted. Send another message to try again.' END
      WHERE status = 'running';
    UPDATE live_attempts SET result = json_set(json_remove(result, '$.activity'), '$.status', 'cancelled', '$.usageComplete', json('false'))
      WHERE json_extract(result, '$.status') = 'running';`);
  }

  workspace(): Workspace {
    const conversations = this.db.prepare('SELECT id, title, binding FROM conversations ORDER BY rowid').all().map(row => ({
      id: String(row.id), title: String(row.title), ...(row.binding ? { kind: 'chatgpt' as const, model: (JSON.parse(String(row.binding)) as ConversationBinding).model } : {}),
    })) as ConversationSummary[];
    const selectedId = this.db.prepare("SELECT value FROM settings WHERE key = 'selected'").get()?.value;
    const summary = conversations.find(conversation => conversation.id === selectedId);
    const messages = summary ? this.db.prepare(
      'SELECT id, role, text, status FROM messages WHERE conversation_id = ? ORDER BY rowid',
    ).all(summary.id) as unknown as Message[] : [];
    for (const message of messages) {
      const attempt = this.db.prepare('SELECT result, evidence FROM live_attempts WHERE message_id = ?').get(message.id);
      if (attempt?.result) Object.assign(message, JSON.parse(String(attempt.result)), { evidence: JSON.parse(String(attempt.evidence)) });
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

  liveContext(id: string): { history: PiMessage[]; evidence: Evidence[] } {
    this.binding(id);
    const row = this.db.prepare(`SELECT a.history, a.evidence FROM live_attempts a JOIN messages m ON m.id = a.message_id
      WHERE m.conversation_id = ? AND m.status = 'complete' ORDER BY m.rowid DESC LIMIT 1`).get(id);
    return row ? { history: JSON.parse(String(row.history)), evidence: JSON.parse(String(row.evidence)) } : { history: [], evidence: [] };
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
    if (!prompt.trim() || prompt.length > MAX_MESSAGE_LENGTH || prompt.includes('\0')) throw new Error('Invalid message.');
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

  progressLive(messageId: string, text: string, activity: string, reported?: Pick<LiveResult, 'usage' | 'requests' | 'usageComplete'>): void {
    this.transaction(() => {
      this.progress(messageId, text);
      this.db.prepare("UPDATE live_attempts SET result = json_patch(COALESCE(result, '{}'), ?) WHERE message_id = ?").run(JSON.stringify({ status: 'running', activity, ...reported }), messageId);
    });
  }

  finishLive(messageId: string, result: LiveResult, evidence: Evidence[]): void {
    const history = JSON.stringify(result.history);
    if (Buffer.byteLength(history) > LIVE_LIMITS.historyBytes) throw new Error('History exceeds the local limit.');
    const { history: _history, reason: _reason, ...publicResult } = result;
    this.transaction(() => {
      this.finish(messageId, result.status === 'partial' || result.status === 'limit' ? 'failed' : result.status, result.text);
      this.db.prepare('UPDATE live_attempts SET history = ?, evidence = ?, result = ? WHERE message_id = ?')
        .run(result.status === 'complete' ? history : '[]', JSON.stringify(evidence), JSON.stringify(publicResult), messageId);
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
