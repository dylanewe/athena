import type { DatabaseSync } from 'node:sqlite';

/** A successful SQL statement is not necessarily a completed WAL checkpoint:
 * concurrent readers report busy without throwing. Leave purge intent pending. */
export function checkpointPurge(db: DatabaseSync): void {
  const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (!result || Number(result.busy) !== 0 || Number(result.log) !== Number(result.checkpointed)) {
    throw new Error('Local purge checkpoint incomplete. Close other readers and retry.');
  }
}
