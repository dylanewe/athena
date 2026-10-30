import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, lstatSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { CredentialProtection } from './model-settings';
import { bearer, ChatGPTError, ISSUER, nonempty, validClient, type Registration } from './chatgpt-protocol';

export interface ChatGPTRecord { version: 1; hostId: string; registration?: Registration; selectedModel?: string }
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
export function validateRecord(value: unknown): ChatGPTRecord {
  const fail = () => { throw new ChatGPTError('storage'); };
  if (!object(value, ['version', 'hostId', 'registration', 'selectedModel']) || value.version !== 1 || typeof value.hostId !== 'string' ||
    !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.hostId) ||
    (value.selectedModel !== undefined && (!nonempty(value.selectedModel) || value.selectedModel.length > 256))) return fail();
  const r = value.registration;
  if (r !== undefined) {
    if (!object(r, ['clientId', 'issuer', 'subject', 'email', 'reconnectRequired', 'tokens']) || !validClient(r.clientId) || r.issuer !== ISSUER ||
      !nonempty(r.subject) || r.subject.length > 1024 || (r.email !== undefined && (typeof r.email !== 'string' || r.email.length > 320)) ||
      (r.reconnectRequired !== undefined && r.reconnectRequired !== true)) return fail();
    const t = r.tokens;
    if (t !== undefined) {
      if (!object(t, ['idToken', 'accessToken', 'refreshToken', 'scopes', 'expiresAt']) || !nonempty(t.idToken) || t.idToken.length > 64_000 ||
        (t.accessToken !== undefined && !bearer(t.accessToken)) ||
        (t.refreshToken !== undefined && (!nonempty(t.refreshToken) || t.refreshToken.length > 64_000 || /[\s\x00-\x1f\x7f]/u.test(t.refreshToken))) ||
        typeof t.expiresAt !== 'number' || !Number.isFinite(t.expiresAt) || t.expiresAt < 0 ||
        !Array.isArray(t.scopes) || t.scopes.length > 100 || t.scopes.some(s => !nonempty(s) || s.length > 256 || /\s/u.test(s))) return fail();
    }
  } else if (value.selectedModel !== undefined) return fail();
  return value as unknown as ChatGPTRecord;
}

/** One encrypted record, committed atomically. No durable plaintext identity or tokens, including SQLite journals. */
export class ChatGPTStore {
  private readonly db: DatabaseSync;
  private failed = false;
  private closed = false;
  constructor(path: string, private readonly protection: CredentialProtection) {
    try {
      try { closeSync(openSync(path, 'wx', 0o600)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error();
      chmodSync(path, 0o600);
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY CHECK(id = 1), encrypted BLOB NOT NULL);');
    } catch { throw new ChatGPTError('storage'); }
  }
  available(): boolean { return !this.failed && !this.closed && this.protection.available(); }
  read(): ChatGPTRecord | undefined {
    if (!this.available()) throw new ChatGPTError('storage');
    try {
      const row = this.db.prepare('SELECT encrypted FROM credentials WHERE id = 1').get();
      if (!row) return;
      if (!(row.encrypted instanceof Uint8Array) || row.encrypted.byteLength > 524_288) throw new Error();
      return validateRecord(JSON.parse(this.protection.decrypt(row.encrypted)));
    } catch { this.failed = true; throw new ChatGPTError('storage'); }
  }
  write(value: ChatGPTRecord): void {
    if (!this.available()) throw new ChatGPTError('storage');
    try {
      const ciphertext = this.protection.encrypt(JSON.stringify(validateRecord(value)));
      this.db.prepare('INSERT OR REPLACE INTO credentials VALUES (1, ?)').run(ciphertext);
    } catch { this.failed = true; throw new ChatGPTError('storage'); }
  }
  initialize(): ChatGPTRecord {
    const existing = this.read();
    if (existing) return existing;
    const record: ChatGPTRecord = { version: 1, hostId: `urn:uuid:${randomUUID()}` };
    this.write(record);
    return record;
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
