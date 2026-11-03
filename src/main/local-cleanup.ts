import type { DatabaseSync } from 'node:sqlite';
import { checkpointPurge } from './local-purge';

/** Deletion and its checkpoint intent commit together. Recovery only checkpoints;
 * it never replays an operation or reconstructs deleted content. */
export class LocalCleanup {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS local_cleanup (id INTEGER PRIMARY KEY CHECK(id = 1), pending INTEGER NOT NULL, deleted_at TEXT);
      INSERT OR IGNORE INTO local_cleanup VALUES (1, 0, NULL);`);
  }
  status(): { cleanupPending: boolean; lastDeletionAt?: string } {
    const row = this.db.prepare('SELECT pending, deleted_at FROM local_cleanup WHERE id = 1').get()!;
    return { cleanupPending: !!row.pending, ...(row.deleted_at ? { lastDeletionAt: String(row.deleted_at) } : {}) };
  }
  recover(): void {
    if (!this.status().cleanupPending) return;
    checkpointPurge(this.db);
    this.db.exec('UPDATE local_cleanup SET pending = 0 WHERE id = 1');
  }
  run(action: () => void): void {
    this.recover();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.db.prepare('UPDATE local_cleanup SET pending = 1, deleted_at = ? WHERE id = 1').run(new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.recover();
  }
}
