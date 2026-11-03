# Focused knowledge maps (#21)

The existing **Services & dependencies** view now pages a larger local inventory rather than rendering a whole architecture graph. It starts with services from the current investigation (when opened from an answer or selected conversation), repository grouping, and immediate concrete neighbors. Without an investigation it uses recent service-first seeds. Interfaces and explicit external/unresolved endpoints remain distinct from services and repositories.

## Navigation and bounds

- **Map name or topic** uses the existing local FTS index over names, aliases, summaries, claims and retained evidence. Queries are literal AND-token searches, not semantic matching. Repository and investigation filters select seeds; concrete neighbors can cross repositories. Connection type selects explicit adjacency only. Provenance filters seeds and displayed claims; freshness filters checked results, not unchecked database flags. Empty/filtered pages are not filled by scanning the ledger.
- **Load more map results** appends another bounded page, deduplicated by claim ID. The display stops at 200 total claims (entities plus connections), a conservative focused-view budget. At depth zero this permits 200 entity nodes. This is a presentation limit, not an ingestion, discovery or permission cap. Initial pages contain at most 20 claims and reserve room for direct concrete connections.
- **Focus entity** replaces the view with that entity. **Expand neighbors** appends incoming/outgoing direct-neighbor pages; repeated expansion uses the next candidate offset instead of restarting. Exhausted expansion is disabled. **Collapse neighbors** removes that expansion's contribution, retaining baseline claims and contributions shared with other expansions. **Reset map focus** reapplies the selected investigation/repository/search filters.
- Deeper views remain bounded leads. Focus a frontier entity to page its direct neighbors. Depth, access, provenance, response bytes and inspection allowances can leave endpoints outside the view. An outside endpoint is labeled as such, never synthesized as a known service.
- The coverage banner explicitly distinguishes loaded pages from omitted/not-loaded content. It never equates absent connections with no relationship. Omission is conservative across appended pages; it can remain set after pagination because earlier bounds or access checks may have withheld material. Repositories outside the map remain labeled not analyzed here/outside the neighborhood, never isolated.
- Entity/connection buttons open knowledge details, conflicts, annotations, readable evidence excerpts and current-file inspection. **Search all knowledge** opens the existing search; **Return to investigation map** returns to the investigation's map. Return rechecks the map rather than replaying a cached evidence snapshot. Follow-up buttons still prepare unsent, editable drafts; only Send starts model work.

All operations use native buttons, labels, selects and forms: paging, focus, expansion, collapse, visual reordering and details work without a pointer. Group order is purely presentational, has no persistence/write API, and never changes relationships. Architecture claims and investigated repositories remain read-only.

## Runtime contract

`neighborhood` adds optional `offset` (0–10,000), `query` (200 characters), `provenance` (`declared` / `statically-inferred`) and `freshness` (`current` / `stale`). Results add `neighborhood.omitted`; `nextOffset` pages seed candidates, or direct adjacency candidates for an entity origin. Pagination is deterministic for an unchanged index, not a snapshot across concurrent new publications. Refresh after knowledge changes. No entire-graph query, external index, paid indexing or model injection was added.

Each page retains the existing 1–20 result, 32 shared provenance-claim, 256 source-identity, 24-KiB and ten-second bounds. Conflicts and annotation inspection still share the same opaque response context; renderer accumulation does not create a larger agent response or provenance allowance. Models still have the existing twelve-call/64-KiB job budget. Byte/provenance/access-withheld candidates are marked omitted, not guaranteed recoverable by paging: narrow filters or inspect a focused claim. Revocation, sticky staleness, checkout authority, request-input eligibility, secret/exposure guards, physical ownership, historical reconstruction, recoverable purge and retention paths are unchanged. Source-access changes remount and clear the map; failed reads clear accumulated leads. Stale/conflicting claims retain explicit labels and evidence navigation; current sources are not semantic verification. Static analysis is not runtime tracing.

## Layout compatibility decision (2026-11-03)

**Chosen:** existing Svelte 5 components with Chromium-native CSS Grid and textual directed connections, no new diagram/layout dependency. The map is an evidence-navigation surface, not a coordinate editor. Native grouping retains DOM reading order, ordinary keyboard controls, wrapping evidence paths, and no force-layout worker or whole-graph input. No permissions, workflow, cost behavior or major architectural boundary changes are needed.

Compatibility checks on the installed stack:

| Option | Check | Decision |
| --- | --- | --- |
| Native CSS Grid / Svelte DOM | Production Vite 8 build, TypeScript/Svelte checks, real Electron 45 desktop tests; 200 entity cards, keyboard Enter paging/focus, groups, scope replacement and evidence navigation | Selected; already supported in the embedded Chromium, no extra runtime/network dependency |
| `@xyflow/svelte` 1.7.1 | `npm view @xyflow/svelte version peerDependencies engines license --json`: MIT, peer `svelte: ^5.25.0`, compatible with installed 5.57.3; no engine constraint declared | Plausible future coordinate-diagram adapter, not needed for bounded repository cards; would require additional editing/keyboard behavior and package integration checks before adoption |
| `cytoscape` 3.34.4 | `npm view cytoscape version peerDependencies engines license --json`: MIT, Node >=0.10, no Svelte peer requirement | Could mount imperatively, but a canvas renderer would need a separate accessible DOM navigation surface. Not installed or claimed runtime-tested |

Package metadata is compatibility screening, not proof that an uninstalled alternative works. Only the selected native layout was built and exercised end-to-end. No new dependency or coordinate persistence schema was added.

## Personal macOS responsiveness

Measured locally with sleep inhibited (`caffeinate -dimsu`), on a Mac mini / Apple M4 (10 cores), 16 GB RAM, macOS 26.6.2. Node 24.19.0; Electron 45.0.0 / Chromium 156.0.8078.48. Synthetic local fixture: **100 actually discovered Git repositories, 1,000 centrally published entity claims, 1,000 explicit cyclic connection claims**, one short implementation file per repository, real SQLite/FTS, source access and checkout freshness checks. No live model calls. Publication/setup (~31 seconds) is separate from interactive latency; setup runs in small hooks under unchanged default timeouts.

Representative measured runs:

| Operation | Measurement |
| --- | --- |
| Discovery of 100 repository directories | 8.88 ms |
| 20 repository neighborhood queries, full main-private checked responses | median 66.29 ms; p95 67.60 ms; max 76.25 ms |
| Open map through real Electron/preload/Svelte | 180.07 ms |
| Nine keyboard-triggered append/render operations, 20 through 200 visible entities | median 201.10 ms; max 218.44 ms |
| Replace 200-node view with one repository's ten entities | 103.06 ms |

Desktop timings include bridge work, rendering and Playwright observation overhead, not isolated CPU layout time. These are measured acceptance evidence, not universal latency guarantees: large files, slow storage and broader provenance can be slower or fail closed under the existing bounds. No test timeout was increased. A separate test discovers a 101st repository and publishes/searches a 1,001st entity to demonstrate these acceptance sizes are not caps.

## Deterministic evidence

- `tests/unit/architecture.test.ts`: omitted/withheld pages, literal topic/provenance/freshness filters, deterministic repeated expansion, candidate offsets, cyclic connections, scope changes; existing external/unresolved, permission/revocation and persistence checks remain.
- `tests/unit/large-map.test.ts` with `tests/fixtures/large-map.ts`: actual discovery/publication at the acceptance sizes, bounded bytes/results, cyclic traversal, search responsiveness, and ingestion beyond the targets.
- `tests/desktop/large-map.spec.ts`: production Electron/preload/Svelte, keyboard paging to 200, disabled loading at the focus limit, scope replacement, topic search, focus/expand/collapse and measured interactive latency.
- `tests/desktop/workspace.spec.ts`: existing investigation-default groups and external endpoints, filters, focus/expansion/collapse, detail/search/map round trip, readable retained/current evidence, unsent follow-up drafts and source files unchanged.

All fixtures are local and deterministic; they make no live model calls and require no credentials.

Validation run: `caffeinate -dimsu npm test` passed **584 ordinary unit + 2 large-map unit tests (586 total), 45 desktop tests**, including production build and `tsc --noEmit && svelte-check` (zero errors/warnings). Full log: `/tmp/athena-21-full-final.log`. Earlier red-loop and focused logs: `/tmp/athena-21-red.log`, `/tmp/athena-21-ui-red.log`, `/tmp/athena-21-nav-red.log`, `/tmp/athena-21-map-final.log`, `/tmp/athena-21-nav.log`.

An initial simultaneous full-unit run timed out an existing source-budget test (5.46 seconds against its unchanged five-second deadline). Its 52-test file passed in isolation, the ordinary full suite passed without the large publication fixture, and the combined targeted run passed. `test:unit` now runs the filesystem-heavy large-map acceptance fixture after the ordinary suite to reduce contention. No timeout, assertion or permission bound was relaxed. The serialized full run passed. Initial failure and diagnosis logs: `/tmp/athena-21-full.log`, `/tmp/athena-21-budget-isolated.log`, `/tmp/athena-21-budget-contended.log`, `/tmp/athena-21-budget-normal.log`.
