import { randomUUID } from 'node:crypto';
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
      UPDATE messages SET status = 'cancelled',
        text = 'Demonstration interrupted. Send another message to try again.'
        WHERE status = 'running';
    `);
  }

  workspace(): Workspace {
    const conversations = this.db.prepare('SELECT id, title FROM conversations ORDER BY rowid').all() as unknown as ConversationSummary[];
    const selectedId = this.db.prepare("SELECT value FROM settings WHERE key = 'selected'").get()?.value;
    const summary = conversations.find(conversation => conversation.id === selectedId);
    const messages = summary ? this.db.prepare(
      'SELECT id, role, text, status FROM messages WHERE conversation_id = ? ORDER BY rowid',
    ).all(summary.id) as unknown as Message[] : [];
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
