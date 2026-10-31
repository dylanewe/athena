# Retrieve and reuse existing knowledge (#9)

## User behavior

**Knowledge** searches local SQLite full text over topic names, optional aliases, concise summaries, claims and cited retained evidence. Inspected-but-uncited source files are dependencies, not searchable evidence. There are no embeddings, remote indexes or paid indexing jobs. Search is literal token conjunction (up to twelve Unicode word tokens); punctuation cannot introduce SQL or FTS operators. Empty search browses a bounded recent page. **Repository scope** is the registered name/alias, case-insensitive and NFC-normalized, not a physical basename. Non-Git material uses `folder:<absolute designated folder>`. **Exact topic or alias** requires a scope and performs exact normalized name lookup, not fuzzy equivalence.

Results are ranked by FTS5 BM25 (topic/alias > summary > claim > evidence), with deterministic recency ties. Each result separates source freshness from provenance, temporal perspective and semantic validation. **Current** means inspected dependencies passed current source checks, not that an unchecked interpretation is verified. **Supported** still only certifies the presence of an intended/historical declaration. Static inspection is never runtime tracing; implementation evidence takes precedence over documentation. Changed eligible material can appear as a **stale investigation lead**, never as current support. Currently revoked, ignored, protected, missing or otherwise inaccessible source derivations are withheld entirely from retrieval.

**Knowledge details** navigates by a returned K ID and shows bounded dependencies, explicit relationships and originating answers. **Read retained excerpt** rechecks current access before releasing at most 1,200 characters, marking truncation. Evidence pointers preserve repository/path, line spans, original revision and file hash. **Inspect current file** uses the existing read-only Sources boundary and warns about changed/unavailable content; explicitly reconnected repositories resolve current evidence at their new location. Answers that retrieved knowledge expose **Retrieved knowledge** links back to individual details. Retained publication links from #8 remain available.

Search shows at most eight records per UI page. The shared service accepts 1–20 records, default eight, offsets 0–10,000, queries up to 200 characters, and returns at most 24 KiB per response. Hidden results consume their raw ranked page positions; a page may be empty while **Next page** remains available. This deliberately avoids an unbounded scan to fill a visible page and leaks no inaccessible counts/content. Very large records/derivations can be withheld by retrieval bounds. No match, a partial page, or a withheld file is **not proof that a behavior/dependency does not exist**. Try another name/query/scope or ask for a fresh investigation.

## Runtime and safety

The renderer's authorized read-only `knowledge.retrieve` and main agent's `retrieve_knowledge` tool use the same validated application service. The agent tool wraps the request in an object (`{ request: { operation, ... } }`) for provider function-schema compatibility. Operations:

- `search`: query, optional scope/exact name, optional originating message, bounded limit/offset.
- `detail`: one existing K ID, with bounded evidence pointers, owners, dependencies and relationships.
- `evidence`: K ID + evidence index (0–7). Returns a bounded retained excerpt. Only current, reread-matching evidence can be registered by main as an E citation. Local K IDs are not runtime citations. If a full citation cannot fit the response, delegate investigation for a smaller source range.
- `expand`: K ID + selected `supports`, `depends-on`, `conflicts-with` types, bounded limit/offset. Returns accessible target records and their connecting typed edges, one hop only. No inferred/similarity edges or transitive graph output. This is the relationship explorer's future composition seam, not a graph UI.

Requests are untrusted data validated with a discriminated TypeBox schema in main, parameterized SQL and fixed SQL fragments. The SQLite FTS5/name tables are rebuildable indexes in the separate knowledge database, transactionally updated with publication and cascaded on clear. Existing #8 profiles receive a one-time local index backfill; no repository reads, model calls or provider credentials are needed for that backfill. Optional topic aliases do not silently merge differently worded records.

Retrieval checks only bounded candidate derivations, not the whole ledger. It follows explicit `depends-on` edges for #8 freshness, capped at 32 claims and 256 unique source identities per response; incomplete access coverage fails closed. Current source exclusion/secret rules run outside the model and cannot request exceptional environment access. Each operation also has a ten-second abort deadline. These conservative bounds may withhold a large dependency closure; use fresh bounded exploration instead. Freshness remains a best-effort local filesystem check, not an atomic multi-file snapshot.

The supervisor additionally caps retrieval at twelve calls and 64 KiB of delivered knowledge payload per user job, independently of model instructions. Only query-selected leads (at most eight) enter the investigator's isolated context. No historical knowledge or unrelated conversation preload occurs. Successful current evidence enters the main-owned evidence ledger and the existing pre-answer/pre-follow-up verification path; models cannot mint E IDs. Retrieval tool-result snapshots are replaced with a protocol-preserving 'retrieve again' placeholder in saved main history so stale/revoked payloads are not automatically replayed on follow-up. The current conversation's ordinary history and citations keep their existing semantics.

No query/index write tool, source write, shell, network search service, provider fallback or new paid workflow is added. ChatGPT and API-key role pins, per-request authority, endpoint permissions, cost reservations, source read-only boundaries and #7 tainted-context publication/persistence guards are unchanged. Retrieval references are main-owned, bounded navigation metadata; exposed/sealed jobs cannot persist them or retrieval history. Launch/change invalidation, broader revocation lifecycle and refresh/rebuild workflows belong to #10, not this slice.

## Deterministic evaluation and known lexical misses

`tests/unit/knowledge.test.ts` exercises real SQLite and the real Sources boundary: names/aliases and scoped collisions; evidence-only terms and uncited-file exclusion; topic-vs-summary ranking; default/explicit limits, pagination and byte caps; missing records; literal hostile query text; changed/ignored/revoked sources; current-vs-stale evidence; details, typed edge expansion, restart/clear/rollback and authorized IPC.

`tests/unit/live-supervisor.test.ts` exercises real Pi agents with scripted Responses: query-selected reuse with no investigator, current E registration, stale/no-match fallback, investigator lead isolation, twelve-call/context bounds and retrieval-snapshot removal. `tests/unit/api-conversations.test.ts` covers the same reuse on independently pinned API-key roles with per-request reservations. Existing environment-exposure tests still inspect SQLite/WAL/SHM for canaries. `tests/desktop/workspace.spec.ts` covers real Electron/preload search, exact alias lookup, missing-match guidance, details/evidence/current-file navigation, reused-answer navigation, restart and staleness. No live models/credentials are required.

Representative captured failures on the fixture whose topic is **Gateway**, summary **Gateway serving boundary**, claim/evidence **The service handles requests.**:

| Query | Observed result | Why |
| --- | --- | --- |
| `gateway` | Ranked topic hit before summary-only hits | Shared lexical token |
| `requests` | Claim/evidence match | Shared lexical token |
| `HTTP ingress` | No match | Neither token occurs |
| `accept incoming traffic` | No match | Paraphrase without shared vocabulary |
| `serves network clients` | No match | No stemming/synonym/semantic matching |

These misses are asserted, not hidden as 'proof of absence'. Use explicit aliases, alternate terms and bounded source exploration first. This slice makes no embeddings proposal; any later proposal should evaluate these and representative real questions against the lexical baseline.
