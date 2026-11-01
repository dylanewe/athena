# Named-operation request flows (#13)

Ask Athena how an explicitly named operation proceeds across eligible repositories and documents. The existing isolated Pi investigator inspects ordinary code/docs; no manifest, standard flow file, repository code execution or runtime instrumentation is required. Implementation evidence takes precedence over documentation. **Not a runtime trace**: the ordering is a source-backed interpretation, not observed execution or exhaustive execution-path/state/failure coverage.

**Open investigation flows** on a retained answer opens its flows. **Request flows** in the sidebar browses a bounded retained list. The read-only **Services & dependencies** map links the investigation's flows and **Flows through this service**. Select a named operation to see numbered steps, owning service/source locations, synchronous/internal/unknown handoffs, and explicit omissions. The view labels documented behavior, static support, uncertain interpretations, stale sources and external/unresolved internals separately. Source freshness and semantic certainty are different: fresh code alone does not certify an interpretation. Step/handoff evidence opens the existing knowledge detail, current-file inspection, conflicts and version-bound annotations. Links return to the flow, service map and originating conversation.

Browsing never starts model work. Generating a new flow uses only an explicit conversation Send and its existing provider/role pins, endpoint permissions, shared request/time/cost gates and folder/secret policy. There is no new automatic/launch paid work, credential route or write access to investigated repositories.

## One claim authority

An investigator may submit an ordinary `kind: 'operation'` candidate with an optional `flow` field:

```ts
{
  steps: [
    { name: 'Accept checkout', service: 'C1', claim: 'C4', state: 'implementation' },
    { name: 'Charge account', service: 'C2', claim: 'C5', state: 'implementation' },
    { name: 'Bank boundary', service: 'C3', claim: 'C6', state: 'unknown' }
  ],
  handoffs: [
    { kind: 'synchronous', claim: 'C7' },
    { kind: 'synchronous', claim: 'C8' }
  ],
  omissions: ['Bank internals, retries, failures and alternate branches not investigated.']
}
```

Every service, meaningful step and handoff references a separate ordinary evidence-bearing claim, using local C IDs or explicit retained K IDs, never name matching. The operation itself also requires evidence and the normal candidate fields. A step's `claim` must be a behavior, responsibility or non-flow operation claim. Repository-backed step support must belong to its owning entity's scope. `implementation` requires current statically inferred support, and cannot describe unavailable external/unresolved internals. `documented` requires declared support; `unknown` explicitly preserves missing implementation or uncertainty. These checks validate structure/references, not semantic truth.

Handoff i connects step i to step i+1; every adjacent pair must have one. A `synchronous` handoff references a concrete `api-call` relationship with exactly the adjacent owning endpoints. `within-service` requires the same owning entity on both sides and an ordinary supporting behavior claim. `unknown` requires an ordinary evidenced claim explaining the gap; it never creates a guessed service connection. At least one explicit omission is required. Larger operations must be investigated as bounded portions, not silently flattened into exhaustive coverage.

`Knowledge.publish` remains the sole writer. It builds ordinary support first, relationships next and operations last, resolves references independently of candidate submission order, and adds ordinary `depends-on` links to all flow support. Flow order/labels/handoffs/omissions participate in exact version identity. Complete batches pass shared source/reference/checkout checks and live cancellation/sealing/secret guards before the same deterministic SQLite transaction commits. A rebuildable service-to-flow index is updated inside that transaction; it grants no graph or source authority. Failed validation cannot leave partial flow/support/index writes.

Flow support, conflicts and durable annotations reuse the same transitive access/freshness checks, sticky checkout invalidation, generation/version binding and explicit annotation reconnection. Flow retrieval, search, detail and evidence all retain complete main-private derivations, even without an E citation. These join subsequent model-request/completion checks and saved follow-up checkout coverage. Only a separately verified current evidence read can mint an E citation. Main-private provenance never crosses renderer/model IPC. #7's live taint predicate remains authoritative at actual invalidation/publication writes; exposed or sealed jobs cannot retain derived history, flow claims or annotations.

## Shared bounded lookup

The existing validated `knowledge.retrieve` interface adds:

- `{ operation: 'flows', messageId?, serviceId?, limit?, offset? }`: bounded retained operation list, optionally filtered by answer and/or explicit owning service.
- `{ operation: 'flow', id: K_ID }`: operation and its ordered supporting claims. Unavailable or oversized complete support is withheld, never returned as a supposedly complete partial sequence.

A flow has 1–6 steps and 0–5 handoffs; one operation plus six services, six step claims and five handoff claims fit the existing 20-result maximum. Ordinary provenance still shares the response's 32-claim / 256-source / ten-second / 24-KiB envelope, including all conflict and annotation-version/original-binding attachments. The original twelve-call / 64-KiB aggregate knowledge job budget and model request/deadline/cost bounds remain unchanged. List paging is bounded and does not scan to fill access-withheld pages. Absent results are not proof of absence.

## Deterministic coverage

- `tests/unit/flows.test.ts`: multi-repository ordering/handoffs, explicit external internals, documented/internal/unknown portions, persistence/reopen and service/answer lookup, order-independent identity, malformed references/endpoints, changed-source and revoked publication, prior-claim dependencies, sticky invalidation, access revocation, version-bound annotations, live invalidation authority and total byte withholding.
- `tests/unit/live-supervisor.test.ts`: real Pi agents with scripted Responses reuse `flow`, `flows`, search, detail and evidence without fresh investigation; all join transitive saved-history checkout coverage. Flow conflict/annotation attachments contribute to live completion freshness even without E citations.
- `tests/desktop/flows.spec.ts`: real Electron utility process/preload/Svelte extraction from ordinary code/docs in two repositories with two synchronous handoffs, missing implementation, ordered navigation between answer/map/service/flow/evidence, current-file inspection, read-only sources, restart and changed-source labels. A named scripted-investigation fixture option avoids expanding the legacy positional-boolean seam.

No live model calls or credentials are required. Existing ChatGPT/API-key, taint, graph-budget, source and annotation suites remain authoritative regressions.
