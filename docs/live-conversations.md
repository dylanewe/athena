# Live ChatGPT conversations (#25)

New conversations use the saved ChatGPT subscription connection by default. This is the approved **single-agent** slice, not completion of #5's separate delegated-investigator design. Existing demonstration conversations remain readable but cannot be sent to a provider. DeepSeek remains a separate fixed connection test, not a fallback.

## User workflow

1. Connect ChatGPT and explicitly choose a discovered model in Model settings. This is the same model selection used for the fixed connection test. No connection test is required before chatting.
2. Start a conversation and send a question. Send authorizes ChatGPT plan/enabled-credit usage and transmission of history and eligible source material. Connection details live in Model settings rather than a repeated warning beside the composer; there is no additional provider checkbox, per-repository permission, scope picker, or activation gate.
3. The first successful local transaction saves the question, assistant attempt, model/registration binding, and locally derived title. A failed initial save retains the unsent draft. Model-derived naming is deferred; no hidden naming request occurs.
4. On Send, Athena refreshes the catalog if it is not loaded and refreshes expiring access credentials when needed. Startup never performs provider requests. A missing selection, unavailable pinned model, missing plan permission, or unavailable registration stops the job with guidance—no replacement is selected.
5. Answer text streams with concise source-tool activity. Conversation-wide request/token totals appear once beneath the chatbox, not on individual replies. Totals include retry attempts. Token usage is shown only when the provider actually reports valid counts. Partial totals are labeled incomplete; internal Pi cost placeholders are never displayed as zero-dollar usage.
6. Stop, close, quit, disconnect, and renderer failure cancel work; minimizing continues. An explicit **Retry** reruns the latest incomplete attempt's original question from preceding completed history, with fresh execution limits and fresh source reads. It retains the old attempt without duplicating the user question. No tool loop is resumed or automatically retried.

A conversation is pinned to its initial model and registration fingerprint. Changing settings affects new conversations. Forgetting a registration and using another account cannot silently transfer old transcripts. Reconnecting the same registration restores its authority.

## Source access and evidence

All conversations use the **current globally designated directories**. There is no conversation-specific directory restriction. Folder consent is still required; future repositories inside a designated folder are eligible under the same global policy. A newly designated folder becomes available to subsequent jobs. The model gets current folder/repository metadata, not authority to change it.

Main brokers only `sources_list`, `sources_search`, and `sources_read` through the shared [source-access boundary](sources.md). The worker never opens source files directly. Each operation rechecks folder consent, canonical confinement, symlinks, excluded/protected names, file limits, and heuristic secret checks. Main validates the operation and arguments independently. Tool output and the final serialized model request are secret-checked. Suspected secret values are not included in errors. Detection is not a guarantee.

No shell, writes, execution, arbitrary network tool, history checkout, repository instructions, extension discovery, MCP, or skill loading is enabled. Comments and repository instructions are untrusted evidence, not executable authority. Implementation evidence is preferred over documentation; static reading is not runtime observation.

Main assigns stable `[E1]`-style identifiers to observed excerpts. Saved evidence includes folder/repository identity, relative path, line range, revision when available, content hash, and bounded excerpt. The UI offers an evidence disclosure and **Inspect current file**, which uses the ordinary source boundary and warns if the current content hash differs.

Before a new user job, retained evidence is revalidated **before any provider request**. Changed, missing, or newly forbidden historical evidence blocks sending and directs the user to a fresh conversation; history is not silently pruned. Before completing a job, all observed evidence is rechecked and referenced evidence IDs are validated. Changed/unavailable evidence or an unknown ID produces an explicitly **partial** answer, never a falsely verified completion. This checks provenance/freshness, not semantic truth of every model claim. Source reads are not an atomic filesystem snapshot; concurrent mutation after revalidation is still possible.

## Runtime ownership

```text
Athena main: protected OAuth + serialized refresh + pinned model/registration
    → request-scoped access token
supervised Electron utility: pi-agent-core Agent
    → Athena stream wrapper
    → pi-ai OpenAI Responses serializer/stream adapter (apiKey: accessToken)
    → https://api.openai.com/v1/responses
```

`apiKey` is Pi's credential argument; it sends the OAuth bearer and does not choose API-key billing. There is no provider registry or ambient credential resolution. Worker environment is empty and stdio ignored. Refresh/ID tokens never enter the worker. A fresh access grant is brokered before every model request, with refresh rotation committed before granting authority.

The wrapper constructs an allowlisted subscription payload: model, serialized input, optional function tools, `store:false`, `stream:true`, and encrypted reasoning replay support. It supplies no sampling fields, output-token caps, service tiers, server-stored conversation IDs, or automatic truncation. The endpoint and method are fixed; redirects, SDK retries, wrapper retries, and billing/model/account fallback are disabled.

An absent Content-Type is accepted, but an explicitly incompatible media type is rejected. SSE bytes are bounded before SDK parsing. The wrapper requires **`response.completed` with `response.status === 'completed'`** before accepting a model step or handing its tools to the agent. Failed/incomplete events, premature EOF, malformed terminal status, incomplete tool calls, cancellation, and response limits cannot become successful inference. Neither HTTP 200 nor Pi's broader normalized `done` alone is sufficient.

There is one active conversation job, limited to **50 model requests or 15 minutes**. These are execution limits, not billing caps. Additional memory/protocol bounds are 2 MiB serialized history/request, 128,000 answer characters, 200 retained evidence excerpts, 1,000 source operations per job, 8 MiB streamed response per model call, and 512 KiB per SSE event (64 KiB for the fixed test). Source operations keep their existing smaller bounds. Exceeding history limits does not silently summarize or truncate completed history; start a new conversation. Provider context-overflow errors are surfaced separately.

Cancellation kills the utility immediately. If refresh was already started, the credential mutation queue remains held until rotation has been persisted—even after the worker has stopped. Disconnect then revokes the latest refresh token and clears local tokens. Shutdown awaits this bounded credential work without starting another generation request. Process separation is **not an OS sandbox** against malicious trusted application code.

## Persistence and privacy

`conversations.sqlite` migrates legacy conversations in place, preserving IDs, selection, and titles. Live conversations store a non-secret registration fingerprint and model. Attempts retain separate user-question identity, public outcome, usage, structured completed Pi history, and evidence. Incomplete attempts are visible but excluded from later model context. Retry uses preceding completed history; it never replays an unfinished tool call. Abrupt interruption retains streamed text already persisted, marks the attempt cancelled, and makes no provider request on restart.

History is not silently compacted or summarized. Reasoning text is not displayed; protocol signatures needed for stateless replay remain in internal history. That internal history is never exposed through renderer IPC. Renderer receives only public text/status/usage/evidence. Errors are application-authored categories, not raw provider bodies, headers, tokens, or native exceptions.

**Conversation history and source excerpts are not encrypted at rest.** They are durable personal data, separate from the encrypted OAuth database and from any future rebuildable knowledge cache. Treat the profile and its backups as private. Stop does not erase already-incurred usage or previously transmitted content. Storage failure stops work and offers **Retry saving**; an unsaved result stays in memory until successfully saved or the application exits.

## Validation

- `chatgpt-stream.test.ts`: real installed Pi adapter with headerless SSE; wrapper payload and strict terminal/header regressions.
- `chatgpt-exchange.test.ts`: fixed-prompt test now uses the same wrapper, including byte-split UTF-8/CRLF, missing headers, failure/quota/usage handling, no API-key acceptance, and no retries.
- `live-conversations.test.ts`: durable binding, demo isolation, explicit retry/history semantics, interrupted-text preservation across restart.
- `live-supervisor.test.ts`: real Agent and Pi adapter over scripted HTTP, real source checks/SQLite, multi-turn replay, per-step refresh, cancelled-refresh serialization, source policy denials, stale/mutating evidence, limits, usage retention, registration pinning, and disconnect.
- `workspace.spec.ts`: real Electron utility/preload/renderer, headerless Responses, restart, drafts, retry, lifecycle/process failures, storage failures, citations/current-file mismatch, stale evidence, and caller isolation. Only HTTP is scripted for model work; an isolated fake saved registration is encrypted with Electron safeStorage. Full OAuth callback/JWT behavior remains covered by `chatgpt.spec.ts`.

Automated tests use temporary profiles and fake credentials only. Do not point Playwright's mock-Keychain launch at a real profile. The previously authorized narrow-transport live test is not evidence that this new general conversation adapter has been live-verified; no live request was made for #25.
