# Resume without trusting historical answers (#18)

This supersedes prior cross-job transcript replay, initial-model pinning and stale-history blocking in [live conversations](live-conversations.md). In-job [context continuation](context-continuation.md), request-input evidence eligibility, folder/environment permissions and provider cost gates remain unchanged.

## Saved history versus new work

Reopening/selecting a conversation restores its messages, original per-answer evidence identities/excerpts, model/provider labels and selected build scope. Historical citations remain local to their originating answer; **Inspect current file** separately reports matching, changed or unavailable content without rewriting the saved excerpt. All completed saved answers are labeled historical, not current verification. Pre-#18 profiles migrate their original pinned binding to each attempt and recover saved build scope.

Send and Retry use the **explicit current route and selected role models** in Model settings, frozen for the new job. Each current API destination must be approved; revoked credentials and unapproved destinations fail before a worker starts. Current ChatGPT plan permission/connection is required; the existing restriction against transferring a ChatGPT conversation between registrations/accounts remains. There is no automatic model/provider fallback, new scope picker, access restriction or additional paid-work trigger. Saved build scope is a relevance hint only; globally approved current folders still define access. Scope is preserved when sending follow-ups, but unavailable/revoked repositories are omitted from model scope metadata. Retry of a build still checks and preserves its explicitly authorized build scope.

## Bounded reconstruction

Before any new generation/summary, the supervisor runs local knowledge freshness detection and checks the last completed turn's evidence plus transitive checkout provenance. It reconstructs **only that turn's public question and answer**, at most 1,024 Unicode characters each, with an explicit historical-context/non-evidence label. Older constraints/details may be omitted; the UI discloses the bound and the model must ask for clarification when needed. Current questions remain intact under #17's existing capacity checks. No saved protocol history, compaction summary, source-tool output or subagent transcript is automatically replayed.

If any historical dependency changed, was deleted, is unchecked or is no longer permitted, the entire retrieved turn is withheld from outbound context. The UI explains this; the conversation remains usable for explicitly requested fresh work. Original history remains visible locally. Even unchanged historical material contributes **zero citation eligibility**: new answers must retrieve bounded current knowledge/evidence or delegate fresh investigation. Current-job ledgers start empty; a historical E ID alone cannot validate a new citation. Freshness/identity is not semantic certification, and static analysis is not runtime tracing.

Unchanged historical provenance still participates in the current job's pre-request/final checkout checks, preventing mid-job edits from mixing snapshots. Sealed environment-exposed conversations remain read-only and cannot leak derived history into a new job. No launch-time model call, automatic refresh job or paid summary is added.

## Restart and continuation

An abruptly stopped attempt is durably marked cancelled/interrupted with incomplete usage, while available text/citations survive. Queued/running investigators are cancelled; retained findings from interrupted work are provisional/partial. This includes a crash before the first progress checkpoint. Reopening never starts a worker or reserves paid usage. The user explicitly sends a follow-up or retries; Retry keeps the original question once, preserves the interrupted attempt, and creates a new message/job with fresh limits and current model authority. Both API-key and ChatGPT conversations expose Retry.

## Deterministic evidence

- `conversation-resume.test.ts`: selection/scope/evidence/model identity after restart, bounded public reconstruction, no transcript/summary evidence eligibility, pre-#18 migration, early crash and new retry identity.
- `live-supervisor.test.ts`: current-model follow-ups, changed-source fresh investigation, unchanged/changed/deleted/revoked restart cases, old citation rejection, explicit current indexed retrieval, and transitive stale-context exclusion.
- `api-conversations.test.ts`: destination changes requiring new consent, current provider/role changes and per-request reservations; #17 compaction retained while revoked material is excluded before any subsequent provider request.
- `workspace.spec.ts`: actual Electron restart, restored scope, historical citation navigation versus changed/deleted current sources, fresh follow-up investigation, and explicit crash recovery without automatic paid work.

All model HTTP is scripted. These tests do not claim live model validation.
