# Knowledge reset and local retention (#20)

Open **Local data** in the sidebar. These controls use local SQLite operations only: no analytics, uploads, model requests or repository writes. Active jobs and pending unsaved results block mutations. New Send/Retry/Build operations cannot race a maintenance operation. Only the owning desktop main frame can use this bridge; workers have no maintenance tool.

## Reset, then rebuild explicitly

Confirm **Reset knowledge cache** to clear derived claims, relationships, search/name indexes, architecture adjacency and operation flows. The derived-ledger generation changes atomically, invalidating all old build reuse receipts. Conversations (including their independent citation evidence), settings, provider/folder permissions, repository aliases and `resolutions.sqlite` annotations are untouched. No startup scan, migration or saved investigation record automatically republishes deleted knowledge.

Rebuilding may require paid reinvestigation. Use the existing **Repositories → Build/refresh knowledge**, select repositories, and authorize paid processing explicitly. Normal provider/endpoint approvals, folder/environment/secret checks, request/time limits, investigator concurrency and API-key cost reservations still apply. Identical source-backed extraction may produce identical content-derived claim IDs, but the new generation cannot silently bind existing annotations.

Annotations are durable user assertions, not model-generated claim identities. **Knowledge → Show all retained annotations, including unconnected versions** exposes accessible orphaned versions as requiring reconnection; changed evidence requires reconsideration. Reconnection is deliberately manual, through selected main-validated claim/evidence snapshots and explicit user reconsideration, never automatic fuzzy/name/model-ID matching. Each reconnection appends a version and preserves the original physical source-access provenance. Unmatched annotations remain independent; inaccessible/revoked derivations are still withheld under the existing access rules, not exposed by reset. See [resolutions](resolutions.md).

## Retention boundaries

- Conversations, answers, concise investigation findings/scope/uncertainties, usage and citation evidence are retained until explicit conversation deletion (or explicit associated-folder purge).
- Verbose main/tool protocol history and detailed child exploration transcripts expire **30 days after an attempt ends**, by default. Set 0–3650 days, or keep forever. The boundary is inclusive: an attempt ending January 1 at midnight expires January 31 at midnight with the default policy.
- Policy changes are saved locally. They do not themselves delete or restore data. Cleanup runs at launch, hourly while idle, or through **Run local cleanup**. Off-time is accounted for on next launch. Running attempts are never expired.
- Evidence is stored independently of expiring protocol transcripts. Answers retain the exact citation ledger and historical investigation record after both reset and expiry. Expiry does not promote these historical citations into current request-input evidence. Follow-ups still reconstruct only a bounded public turn and use current provider authority and source freshness/access checks.
- Actual approved environment contents and derived output remain non-durable; cleanup cannot make sealed output durable. Original request-root ownership survives expiry. Legacy attempts without a root catalogue whose verbose provenance expires are conservatively associated with withdrawn roots, rather than silently becoming independent of them.

The panel shows the current policy, expired/eligible attempt counts, last deletion/reset times and pending checkpoint status. Answers show a transcript-expired notice. Increasing retention cannot recover expired transcripts, including after a delayed terminal save or child checkpoint.

## Explicit conversation deletion

Select a conversation in the sidebar, return to **Local data**, and confirm **Delete selected conversation**. Its messages, attempts, detailed/concise investigation records and answer evidence are deleted transactionally. Other conversations and settings remain; normalized knowledge and annotations have independent lifetimes and are not deleted here. To remove all data associated with a source, use the existing [folder purge](folder-revocation.md). Late events and restart cannot recreate a deleted attempt.

## Recovery and migration

Deletion uses SQLite `secure_delete`, including the existing FTS secure-delete setting. The transaction commits a local checkpoint-intent marker with the deletion. WAL checkpoint failure leaves a visible pending marker. **Run local cleanup** retries checkpoints; startup completes pending checkpoints before exposing views. Recovery only checkpoints committed deletion: it never replays reset, changes generations again, republishes old investigation candidates or restores expired transcripts. A transaction failure rolls back both state and intent. Physical deletion depends on successful local checkpointing; backups or previously transmitted provider data cannot be recalled.

Existing attempts with unknown end dates begin their retention window at migration time, avoiding immediate age-based deletion of legacy history. Migration adds retention metadata only; it does not recategorize conversations, annotations, permissions or settings as cache. Failed/cancelled/interrupted attempts remain concise historical records, with explicit retry still required. Revocation/purge markers and immutable original physical ownership remain independent of reset/retention.

## Deterministic validation

- `retention.test.ts`: inclusive expiry boundary, forever/zero/invalid policies, retained citations and concise records, legacy migration, late-save/checkpoint non-resurrection, transactional failure, interrupted checkpoint recovery, explicit conversation deletion and conservative legacy ownership.
- `flows.test.ts`: complete index/graph reset, generation rotation, full re-extraction and interrupted reset recovery without automatic reconstruction.
- `resolutions.test.ts`: authorized confirmed reset preserves durable user state; identical re-extraction stays disconnected until explicit reconnection; existing changed-evidence and revoked-origin cases remain in force.
- `api-conversations.test.ts`: real Pi agents with scripted HTTP fully re-extract after reset under unchanged approvals/concurrency/cost gates, without reusing old receipts or making any automatic paid requests.
- `folder-access.test.ts`: expiry/reset/restart cannot resurrect purged annotations, conversations, evidence or revoked original-source knowledge.
- `bridge.test.ts` and desktop tests: maintenance excludes new work, real Electron/preload/Svelte confirmation, visible policy/status, no model calls on reset/reopen, evidence survival, annotation reconciliation, explicit deletion and unauthorized renderer rejection.

No live model calls are required.
