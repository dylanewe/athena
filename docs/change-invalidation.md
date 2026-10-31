# Checkout freshness and on-demand revalidation (#10)

Athena performs a **local-only checkout census on launch** (after discovery) and before a user investigation. Browsing and census work acquire no model credentials, make no model requests and incur no model charges. They never run Git, repository code, hooks, generators, or write investigated sources. Both provider routes, pinned conversation/investigator destinations, endpoint approvals, per-request reservations and shared job limits are unchanged.

## Current checkout, not just cited files

The census traverses eligible working-tree text through the **same Sources access policy, UTF-8 reader, complete-file secret check and content hash** as analysis. Git tracking is not an eligibility rule: tracked, untracked, modified, renamed and deleted files participate equally. Membership, content identities, repository ownership, available Git revision and symbolic HEAD contribute to a deterministic scope fingerprint. An unchanged cited line/file is **not proof of unchanged behavior**: edited callers or configuration invalidate repository-backed findings too. Non-Git text uses its designated-folder scope; no manifest is required.

Sources exclusions remain authoritative: protected environment/credential files, symlinks, ignored/vendor/generated/binary material are not admitted by a census. Explicit ordinary source exceptions still apply, never exceptional environment permissions. Git metadata reads are fixed, bounded local reads; external worktree/submodule gitdir pointers are not followed. Repositories whose Git revision/branch cannot be read still use eligible content identities. Git branch metadata outside the authorized source boundary cannot be certified. A checkout census is bounded by the existing Sources time/entry/input/depth limits. **Incomplete coverage fails closed**, marking knowledge for revalidation and producing a partial investigation rather than certifying an unchanged checkout. Large repositories may require a future approved source-indexing slice; this implementation does not silently broaden read limits.

## Persistence and propagation

New knowledge contributions retain their checkout fingerprints in the separate rebuildable knowledge SQLite database, alongside the existing evidence, inspected-file/list/search dependencies, answer owners and explicit typed relationships. Old profiles without checkout fingerprints conservatively require revalidation, not a migration-time assumption of freshness.

Launch/pre-investigation scans persist invalidations in that database. Invalidation is **sticky across restart and reverts**: observing an incompatible checkout cannot later silently revive an old contribution, its shared owners, or its dependency edges. Explicit `depends-on` relationships propagate invalidation transitively, including across repositories. This mechanism is independent of claim kind and therefore also applies to future entity/relationship/flow claims; it does not infer similarity edges. Unrelated valid repository contributions remain current.

Historical claims and their evidence/owners are preserved for retained answers. Retrieval still applies #9's bounded access-aware filtering, request-wide graph/source budgets, byte caps and deadlines. Currently inaccessible derivations are withheld, not exposed as stale leads. Accessible stale findings can guide investigation, but an evidence request for them cannot mint a current E citation. `Current` only means checked source freshness, never verified semantics or runtime behavior.

A fresh contribution cannot erase old shared ownership. A changed checkout produces a new contribution identity; revalidation after a revert also produces a new identity instead of clearing the old invalidation. Exact repeated derivations retain dependency edges even when a submission omits them. Repointing one of those dependencies requires an **explicit** relationship to a fresh contribution of the exactly matching assertion; no fuzzy equivalence or automatic redirection occurs. Changed assertions remain distinct, and absent/deleted assertions stay invalidated rather than being implicitly reasserted.

## User-requested refresh

Knowledge results show source freshness separately from provenance, perspective and validation. **Prepare refresh** on a stale result opens an **unsent new-conversation draft**, scoped to the topic and prior claim as an untrusted historical lead. Review/edit it and choose **Send** to request fresh source investigation under the ordinary paid-work authorization. Merely preparing a draft, checking freshness or opening the app never starts paid work. The normal conversation activity shows local scanning, investigation and model progress; terminal status and publication labels show partial or withheld results.

Refresh is bounded fresh exploration and extraction, not a whole-ledger rebuild or semantic guarantee. Only newly inspected, freshness-checked candidates can publish. An extraction that omits a deleted assertion leaves that historical assertion stale. Unrelated valid contributions are untouched. Cross-source dependencies can be revalidated incrementally through explicit fresh relationships. Failed, canceled, incomplete or exposed jobs cannot publish new knowledge.

## Edits during work

Before any model request, main captures memory-only checkout baselines. It compares the scopes actually inspected/reused before subsequent provider requests, after source reads, after the answer, in the publication transaction, and immediately before finishing. A changed checkout returns a **marked partial** result without automatic paid continuation; retry is explicit and starts a new bounded job. Athena never switches branches or silently combines incompatible snapshots. Unexposed completed answers retain main-owned checkout provenance with their citations; follow-up history is not replayed if that checkout changed, even when cited bytes still match. Legacy source-backed history without that provenance must start a fresh conversation.

As with existing source reads, this is best-effort local filesystem validation, not an atomic snapshot or filesystem watcher. Changes after the final read, or an edit-and-revert entirely between observations, cannot be detected. Content identity is not semantic proof. #7 tainted/exposed jobs do not persist new checkout provenance, candidates, dependencies, titles, histories or apparently innocuous paraphrases. Snapshot text never enters a model context; only fingerprints are retained by guarded main-owned persistence.

## Deterministic evidence

- `tests/unit/source-checkouts.test.ts`: real temporary Git working tree, tracked/untracked edits, renames/deletions, same-commit branch switch, source exclusions, environment protection and ordinary exceptions. Git commands are fixture setup only, never application behavior.
- `tests/unit/knowledge.test.ts`: unchanged citations versus uncited callers/configuration; revision changes, repeated edits/reverts, sticky invalidation/reopen, shared owners, cross-repository/transitive dependencies, explicit dependent refresh, preservation of unrelated contributions, source mutation during transactional commit, and existing access-aware retrieval/rollback/cancellation coverage.
- `tests/unit/live-supervisor.test.ts`: real Pi agents with scripted responses; edits at source-read, mid-analysis and final-answer boundaries, no extra requests after detected edits, partial results, no publication, and rejection of source-backed follow-up replay after an uncited edit. Existing environment-exposure SQLite/WAL/SHM canary checks remain in force.
- `tests/unit/api-conversations.test.ts`: the same main-owned integration retains independent API-key role pins, endpoint consent, request reservations and tainted-state exclusions.
- `tests/desktop/workspace.spec.ts`: real launch scan detects an uncited configuration edit with zero model/catalog calls; stale evidence/history remain inspectable, preparing refresh makes zero calls, explicit Send revalidates and leaves historical stale knowledge separate from the new contribution.

No live providers or credentials are required.
