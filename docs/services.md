# Services and concrete dependencies (#12)

For #21's paginated filters, 200-claim presentation budget, focus/collapse controls, layout decision and measured large-inventory responsiveness, see [Focused knowledge maps](large-maps.md). The per-response provenance/model bounds below remain unchanged.

**Services & dependencies** opens a read-only, repository-grouped neighborhood. **Explore investigation map** starts from the current answer's retained entities; **Explore neighborhood** on a knowledge detail starts from that claim. Without an answer/origin, the explorer starts from a bounded recent set, optionally scoped by registered repository name. Source locations distinguish entities even when names collide; names in different repositories are never silently equated. Services and interfaces are separate entities, not repository synonyms. A repository can yield multiple services without enumerating every route or adopting a manifest.

Entity/connection buttons open the existing access-checked knowledge detail, evidence excerpts, current-file inspection, origins, conflicts and durable user annotations. **Ask about entity/connection** or **Ask follow-up question** prepares an editable, unsent new-conversation draft containing an explicitly untrusted lead. Only Send starts model work under the existing route, role pins, endpoint approvals and paid-work limits. Reverse visual group order affects display only. There is no graph edit/save/write API.

The map is deliberately not a complete system diagram. Repositories outside its current results are labeled **Not analyzed here or outside the bounded neighborhood**, never isolated. Empty results, absent connections and partial interfaces are not proof of absence. Static connections are never presented as runtime observations. Implementation evidence takes precedence over documentation; provenance, perspective, source freshness and semantic validation stay separate.

## Structured extraction and persistence

The existing investigator `finish_investigation.knowledgeCandidates` contract adds two claim kinds:

- `entity`, with `architecture: { type: 'service' | 'interface' }`, requires evidence in its registered repository scope. External/unavailable or ambiguous targets use `{ type: 'external' | 'unresolved', resource: 'service' | 'api' | 'datastore' | 'library' | 'deployment', address?: string }`. Their claim scope records where the evidence was found; the UI groups these targets separately, not as invented repositories.
- `relationship`, with `architecture: { type: 'api-call' | 'event' | 'shared-library' | 'data-store' | 'deployment', from: C-or-K-entity-ID, to: C-or-K-entity-ID, mechanism: string }`. Mechanisms identify concrete routes, event topics, imports, stores or deployment references. Endpoints must be explicit entity claims, not strings guessed from names. Unknown names become explicit unresolved entities. Same-technology/concept/responsibility similarities do not create connections.

These remain candidates, not model writes or semantic certification. Every entity/connection carries the ordinary claim text, source evidence IDs, provenance and perspective. Runtime-observation and similarity relationship types are not accepted. Central `Knowledge.publish` validates the complete batch, resolves endpoints independently of submission order, reconciles exact identities and publishes transactionally. Typed fields participate in version identity. Existing differently worded or source-derived assertions are not overwritten.

Connections receive ordinary `depends-on` links to both endpoint claims, with ordinary answer ownership. This makes their transitive files/scopes/checkouts subject to the existing permission, source-secret, checkout, sticky invalidation and revocation policy. Repeated publication cannot drop retained dependencies. Changed endpoints require explicit fresh claims/connections, not automatic redirection. Services, interfaces and connections support the same version/generation-bound durable annotations and explicit reconnection semantics as every other claim. There is no second graph provenance or persistence authority. Two rebuildable SQLite adjacency indexes are updated inside the existing publication transaction and cascade with derived claims.

## Shared bounded lookup

The renderer and `retrieve_knowledge` agent tool use the same validated `knowledge.retrieve` operation:

```ts
{ operation: 'neighborhood', id?: K_ID, scope?: string, messageId?: string,
  depth: 0 | 1 | 2 | 3, limit?: number,
  kinds?: ('api-call' | 'event' | 'shared-library' | 'data-store' | 'deployment')[] }
```

Use either an explicit claim origin or optional repository/answer seed filters, not both. Scope limits initial seeds; concrete connections can cross repositories. Traversal is incoming and outgoing, breadth-first, following only explicit indexed relationships. Depth counts connection hops, not the number of provenance claims required to validate an endpoint. Depth zero returns seed entities only (a relationship origin selects its endpoints). Both entities and connection claims consume the 1–20 result limit (default eight; UI twenty). Nonzero-depth multi-seed views reserve initial slots for connections and opposite endpoints before filling unused space with additional seed entities. Large/withheld results never trigger an unbounded scan to fill the view. Cycles terminate by claim identity.

All traversal and existing conflict/annotation attachments share the original response's 32-claim and 256-source-identity provenance budget, ten-second deadline and 24-KiB total byte cap. The same opaque read context accumulates conflict and annotation-version/original-binding coverage, and the complete byte envelope is finalized again after attachment. Oversized graph derivations fail closed rather than dropping provenance. All typed entity/relationship reads (including search, details, evidence and attached versions, not only neighborhood operations) retain complete main-private transitive derivations even without an E citation: subsequent requests, final completion and saved follow-up history check the job's current checkout baseline for all delivered graph scopes. Only a current, matching ordinary evidence request can mint an E citation. Raw derivations never cross renderer/model IPC. The shared twelve-call/64-KiB knowledge job budget and model request/time/cost gates are unchanged.

#7's dynamic taint authority still controls invalidation writes at the actual write, publication and persistence. Renderer freshness reads receive a live main-owned predicate and cannot persist invalidations during any active job or from a selected sealed conversation; absent authority defaults to read-only. Unexposed model jobs retain their own existing live authority predicate. Exposed/sealed/canceled contexts cannot publish typed claims or save graph-derived history/checkouts/annotations. Graph browsing invokes no model, credentials, repository code or source writes.

## Deterministic checks

- `tests/unit/architecture.test.ts`: progressive/multi-service repositories, scoped collisions, cross-repository concrete calls, interfaces, all five connection types, external stores, unresolved targets, no similarity edge creation, evidence navigation/reopen, malformed candidates, bounded depth/results/bytes, endpoint revocation and sticky transitive checkout invalidation.
- `tests/unit/live-supervisor.test.ts`: scripted real Pi agent neighborhood reuse without E citations, conflict/annotation coverage on neighborhood and typed evidence reads, transitive edits during analysis and before follow-up, alongside existing tainted-context, publication and request/context-budget coverage.
- `tests/desktop/workspace.spec.ts`: real Electron utility/preload/Svelte extraction, repository/external grouping, connection evidence/current-file navigation, display-only reordering, depth filtering, neighbor expansion, unpaid editable follow-up draft and restart. A held detail IPC response deterministically verifies that annotations cannot be edited against a pending snapshot; the ordinary version-binding/rebuild regression then completes.

The existing central knowledge, annotations, API-key and ChatGPT regression suites remain authoritative. No live model calls or credentials are required.
