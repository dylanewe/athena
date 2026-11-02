# Folder revocation and local purge (#19)

In **Repositories → Designated folders**, **Revoke folder access** withdraws permission immediately. The inventory commits a revoked-grant tombstone before stopping the current worker, its running/queued children, and source browsing. Every connected overlapping grant is withdrawn too (including sibling grants under an overlapping ancestor). There is no silently remaining authorization through an outer grant or repository alias. This slice does not restore revoked grants: choosing an overlapping folder again is rejected explicitly, not treated as renewed consent.

Sources recheck current permission throughout IO and before releasing results. Revocation discards an in-flight result's excerpts. Original physical source ownership also gates retrieval, historical reconstruction, annotation targets, checkout reuse, model-request authority and normalization's final commit guard; reconnecting a repository name cannot authorize old evidence. #17 immutable request inputs/eligible evidence and #18 current provider authority remain unchanged.

## Retain history by default

Conversations remain local and carry **Revoked sources** labels. Source-associated conversations, including their later turns, are excluded from protocol replay, bounded historical reconstruction, retries and deferred title generation. New explicit questions can still use current settings without reusing the revoked history. Saved citations are historical, not current evidence.

Jobs retain the authorized root catalogue they received at start. Because free-form text and uncheckpointed child work cannot reliably be attributed to individual files, the whole current job is stopped and conversations are conservatively associated with every folder made available to that job. Legacy conversations are associated by persisted citations, tool requests, checkout/build scopes and exploration envelopes. A source-free later turn does not erase earlier ownership.

Revocation cannot recall data already transmitted to providers or undo incurred usage.

## Explicit destructive purge

After revoking, choose **Purge associated local data…**, review the explanation, check **Permanently delete associated local data**, then **Confirm permanent purge**. Keeping history or dismissing confirmation does not delete anything. Main validates confirmation independently of the renderer.

Purge removes:

- affected cached evidence and knowledge contributions, FTS/name/architecture/flow indexes and provenance edges;
- transitive `depends-on` assertions without eligible support;
- associated annotations and all their revisions, including original snapshots after reconnection;
- entire associated conversations, their titles, attempts, transcripts, evidence, later turns and in-memory ephemeral displays;
- affected source exceptions and repository inventory metadata.

Independently source-supported contributions remain even when their topic/claim wording matches a removed contribution. Identity reconciliation does not equate all claims about the same topic. Removing a required dependency removes the dependent assertion, not just its edge. Settings and unrelated conversations remain. Repository files are never written.

The minimal revoked-grant record remains to prevent resurrection. SQLite secure deletion is enabled, FTS secure-delete removes obsolete postings, and completed cleanup checkpoints/truncates WALs. This is application-level deletion, **not** a forensic-erasure guarantee for storage blocks, OS snapshots or external backups.

## Crash and concurrency behavior

Purge intent is committed in the inventory before deletion across the separate local databases. The idempotent service drains serialized annotation/knowledge writers, deletes data and clears the pending marker only after every step succeeds. If any step fails, access stays revoked and the UI explains that purge is incomplete. Retry purge or restart: recovery replays pending deletions **before opening the window**. There is no cross-database atomicity claim. Late worker results, retries of unsaved terminal events and discovery reconciliation cannot recreate purged attempts or authorized repositories.

Deterministic coverage lives at the source, inventory, folder-access service, live supervisor and Electron/preload/IPC seams. Tests use synthetic model responses only, including in-flight reads/retrieval, pending request authority, publication rollback, queued children/late results, shared claims, interrupted cleanup, restart and historical-context filtering.
