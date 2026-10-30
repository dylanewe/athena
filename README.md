# Athena

A personal macOS investigation workspace. New conversations use your ChatGPT plan for streamed answers and read-only investigation across globally designated folders ([#5](https://github.com/dylanewe/athena/issues/5) + [#25](https://github.com/dylanewe/athena/issues/25)). One conversational agent delegates fresh source exploration to an isolated investigator and receives bounded cited findings, not its transcript. History and cited evidence persist locally. Existing demonstrations remain view-only. Folder discovery itself contacts no model and incurs no model usage. DeepSeek and ChatGPT retain separate, explicitly clicked connection tests; there is no automatic provider, model, account, or billing fallback.

## Run

Requires macOS and Node.js 24+ with npm. A signed-in macOS desktop session is needed to run the application and desktop tests.

```sh
npm ci          # Installs locked dependencies and the Electron binary
npm run dev     # Typecheck, build with Vite/esbuild, then launch
```

Development deliberately loads built files, not an HTTP development server. After editing, quit and rerun `npm run dev`. To build and launch separately:

```sh
npm run build
npm start
```

If dependency lifecycle scripts are disabled locally, run `npm run postinstall` to install Electron explicitly. Builds are runnable from this checkout; signed application bundles/installers are not included in this slice.

## Try it

1. In **Model settings**, connect ChatGPT and explicitly choose a model. Then choose **New conversation**. Nothing enters the sidebar until the first send.
2. Send your first message (or press **⌘ Enter**). Athena atomically saves the conversation and first prompt, keeps an immediate local title fallback, and streams a ChatGPT answer with a model-derived title. Send authorizes plan/enabled-credit usage and transmission of history and eligible content from globally designated folders. No extra activation or repository prompt is required.
3. Start another conversation and switch between sent conversations in the sidebar. An unsent new draft stays in the current window when you switch conversations or visit Repositories.
4. Quit and reopen Athena: the selected conversation and saved messages return.
5. Send a message and close the window or quit before it finishes. Reopen to see the retained question and cancelled response. Minimizing does not cancel work. **Stop** cancels without closing the window; already-incurred usage may remain.

The selected model suggests a concise title through the main agent's naming tool within the same user job and request/time limits—no separate naming job or provider fallback. If naming fails or is omitted, the whitespace-normalized first-prompt excerpt remains (100 Unicode code points maximum). A later user job can retry naming using the original question. Once a model-derived title is saved, subsequent messages do not rename it. If the first save fails, the draft remains available to retry and no empty sidebar session is created.

There is one active conversation job at a time, limited to 50 total model requests or 15 minutes shared by conversation, investigation and naming, without a ChatGPT dollar gate. Failed, cancelled, partial, or limit-stopped attempts offer **Retry**: rerun the original question from preceding completed history, with fresh limits and source reads, without duplicating the question. No automatic retries occur. An abrupt application interruption is marked as cancelled on the next launch, not silently retried. Unsent drafts live only in the current window. If storage fails during a job, the process still stops and the UI offers **Retry saving**. Free disk space or resolve the storage problem, then retry; the terminal result is held in memory until saved. Quitting before that save succeeds leaves the already-persisted question recoverable as an interrupted job.

Conversations pin their initial model and registration; changing settings affects new conversations. Source tools use the current global folder permissions, not a per-conversation scope. Answers retain cited excerpts and content identities. The **Investigation** disclosure shows inspected scope, source-supported findings versus uncertain interpretations, unresolved questions and candidate knowledge changes (proposals, not automatically applied). Detailed investigator exploration is retained separately, never replayed into the main context or exposed through renderer IPC. **Inspect current file** warns about changed content. Changed or newly forbidden historical evidence blocks follow-up transmission and asks for a new conversation. See [live conversation behavior, ownership, limits, and privacy](docs/live-conversations.md).

## Designate a folder

1. Choose **Repositories → Choose folder**. The native macOS picker selects a directory; Athena displays its canonical path before accessing its contents.
2. Review the permission, check **I understand the folder permission**, then **Save consent and discover**. Consent covers eligible material throughout that folder, including future repositories and non-Git documents. It is saved locally with the exact permission text and acceptance time. It does **not** approve providers, secrets, environment access, or paid work.
3. Discovery finds ordinary Git repositories, nested repositories, submodules, and worktrees. Contents belong to the nearest discovered repository; nested repositories have separate inventory entries. Non-Git files remain eligible and are counted separately. All repositories are **Unexamined**: file counts and directory discovery are not model analysis or runtime tracing.
4. Names default to directory names. When a name collides (case-insensitive, Unicode-normalized), choose a unique alias. Missing repositories retain their identities. After a move or rename, rescan the designated folders (or designate the new enclosing folder); explicitly reconnect the discovered location to its original name, or register it as a new repository. Reconnection preserves the original name/alias and documentation hints; nothing is automatically merged.
5. Configure **Documentation starting directories** per repository, one relative path per line. `docs` is the default; additional or not-yet-created directories are allowed. These are prioritization hints, not content access limits.
6. Use **Cancel discovery** to stop traversal and retain partial results, or **Rescan folders** to retry. Missing/unreadable locations and failures are visible; unchecked locations are not silently treated as missing. On launch, saved roots are rediscovered locally. Closing/quitting cancels discovery; minimizing does not.

Hidden directories, dependencies (`node_modules`, `vendor`, `vendors`, `bower_components`, `venv`, `env`, `Pods`, `Carthage`), and build outputs (`dist`, `build`, `out`, `target`, `coverage`, `__pycache__`) are skipped by default. Use **Include and rescan** with a relative directory to override a skip. Ancestors needed to reach that location are traversed without including their other skipped contents; descendants still use default exclusions. Directory symlinks are not followed, even when explicitly included; Git metadata (`.git`) cannot be included. Worktree/submodule gitfiles are recognized without following their target, which can live outside the designated folder. Nested/overlapping designated roots do not duplicate content.

Repository inventory organizes knowledge; it is not per-repository authorization. No manifest or cross-repository opaque ID is required. Discovery reads directory entries and bounded Git pointer files, never invokes Git or executes repository code, and never writes investigated repositories. Boundary checks reject symlink paths and recheck persisted roots; this is trusted application filesystem traversal, **not an OS sandbox against hostile concurrent filesystem mutation**. Future investigation must validate permissions again when opening material; this inventory is not a reusable filesystem-access capability.

## Browse eligible sources

Open **Sources** after approving a folder. List files, search literal text, or read up to 200 lines with folder/repository identity, line ranges, checkout revision when available, and content hashes. Browsing covers eligible current-checkout and non-Git text without model calls or repeated repository prompts. Environment/credential files, Git internals, traversal, and symlinks are blocked; suspected secrets are withheld before previews/search results. Recognizable environment examples are eligible but still secret-checked.

Default hidden/vendor/generated/ignore exclusions show reasons. Save or remove narrow file/subtree exceptions under **Exclusions and saved exceptions**; exceptions cannot bypass security checks. Operations are bounded and report partial/unsupported inputs. Secret detection is not a guarantee. See [source-access contract, limits, and Pi tools](docs/sources.md).

## Connect DeepSeek deliberately

1. Open **Model settings** to see the pinned `deepseek-flash` configuration, tool/reasoning capabilities, and configured peak token prices. Athena never imports Pi, shell, or repository credentials or changes models automatically.
2. Enter a DeepSeek API key and choose **Save key**. The entry field clears immediately, even on error. Only macOS Keychain-backed ciphertext is persisted; unlock the login Keychain if protected storage is unavailable. Saving a key does not send a request.
3. Review the exact disclosed prompt, output cap, timeout, and conservative estimate. **Test connection** authorizes one potentially paid request containing only `Reply with exactly: Athena connection OK`—no repository content, conversation history, or tools. Reported token usage and estimated cost appear after success; invalid credentials and failed requests give next steps.
4. **Cancel connection test**, window close, and quit stop active work; minimizing does not. An already-sent canceled request may still incur charges. All conservative cost reservations persist across restarts, including failed and canceled requests. The always-enabled **$1 application-wide gate** blocks tests when prices are unknown or the next estimate cannot fit; this slice has no reset/increase control. It is not an authoritative provider billing limit.
5. Separately review and save **Repository provider permission** if you approve DeepSeek for future explicitly chosen repository content, or revoke it. Connection testing never implies this permission. No DeepSeek repository upload/investigation is implemented. Live conversations use the separate ChatGPT route.

No paid test occurs on launch or on saving credentials/permission. See [configuration sources and safety contract](docs/deepseek-connection.md) for verified model metadata, pricing, and accounting details.

## Connect a ChatGPT plan

Open **Model settings → Use your ChatGPT plan → Continue with ChatGPT**. Sign-in opens your system browser, protects the single saved registration with macOS Keychain-backed encryption, and discovers models when plan permission is granted. Choose a model explicitly, then click **Test ChatGPT connection** to send only the disclosed fixed prompt. That test sends no repository content, conversation history, or tools. New conversations separately use this selected model; Send refreshes the catalog and expiring credentials as necessary.

The test consumes ChatGPT plan allowance or enabled credits—not the DeepSeek API key or dollar gate. It has no retries and a 20-second deadline, but no output-token cap (unsupported by this route). Cancellation may not prevent usage already incurred. Reported token usage is shown when available; no dollar estimate or billing fallback is invented.

**Disconnect ChatGPT** clears tokens and attempts remote revocation, reporting if it could not be confirmed. The one registration is retained for reconnect; disconnect and then **Forget disconnected registration** to start over with another account. No account picker or second saved registration exists. Missing plan permission is distinct from sign-in and has an explicit reconsent action. Nothing contacts OpenAI on launch; refresh the model catalog explicitly after reopening.

The protocol is confirmed against OpenAI's documentation. Live saved-session access, model discovery, and a completed fixed-prompt generation on `gpt-6.1-sol` have been verified after fixing missing response-header handling. This confirms that tested account/model request, not universal eligibility. See [ChatGPT protocol sources, decisions, security and validation](docs/chatgpt-connection.md).

## State and safety

- Durable user state is SQLite under `~/Library/Application Support/Athena/state/`: `conversations.sqlite` retains selection, messages, model/registration bindings, structured completed main history, separate investigator exploration checkpoints, source excerpts/citations, usage, and job statuses; `inventory.sqlite` retains folder consent, explicit includes, repository names/locations, unresolved candidates, and documentation hints (with SQLite WAL/SHM sidecars while open). Inventory observations are refreshed on discovery; they are not analyzed knowledge. `models.sqlite` retains the selected model metadata, provider permission, conservative cost reservations, last test outcome/usage, and only Keychain-backed **ciphertext** for the credential. `sources.sqlite` retains source-exclusion exceptions only; browsed excerpts and suspected secret values are not persisted. `chatgpt.sqlite` separately retains one Keychain-backed encrypted record containing the installation ID, single OAuth registration/tokens, and selected model for new conversations and connection tests; no plaintext OAuth credential file is written. Other state is **not encrypted**; treat the profile as private. The state directory is created owner-only and databases owner-readable/writable.
- Rebuildable repository knowledge is a separate concept and is not implemented. Clearing a future knowledge cache must not delete these conversations.
- The Svelte renderer is sandboxed, context-isolated, and has no Node.js, filesystem, or credential API. It renders messages as text, not HTML. CSP and Electron request filtering allow only built UI assets; navigation, popups, webviews, and permission requests are denied.
- The preload exposes conversation `workspace`, `select`, `send`, `retry`, and `cancel` operations, narrow `inventory` and `sources` interfaces, and change notifications. Sources supports only bounded list/search/read, cancellation, and saved exclusion exceptions through shared application-enforced access checks. Sending with a null conversation ID creates a conversation and its first message in one transaction; there is no separate empty-conversation creation API. Inventory supports snapshot, native folder selection/consent/dismissal, scan/cancel, explicit includes, registration/reconnection, and documentation hints. DeepSeek settings expose only snapshot, key entry (never retrieval), provider consent/revocation, and fixed-prompt test/cancel. ChatGPT settings additionally expose sign-in/reconsent, catalog refresh/selection, disconnect, forgetting a disconnected registration, and an application-owned usage-settings link. Neither exposes arbitrary prompts, endpoints, credentials, prices, filesystem reads, or IPC. Main validates the owning window, main frame, exact document URL, operation, payload shape, IDs/names, and length bounds. Only a pending native picker selection with the exact displayed permission text can designate a root.
- Electron starts a utility process only for a user-sent conversation or an explicitly requested connection test, supplies an empty environment, and terminates it on completion, failure, timeout, or cancellation. Closing the last window quits the app. There is no investigation daemon, persistent HTTP backend, or analytics. Live ChatGPT requests transmit conversation history and eligible source material; local browsing and discovery do not. ChatGPT sign-in temporarily binds an ephemeral `127.0.0.1` callback listener; it closes after the attempt.
- Live conversations use **pi-agent-core** directly for isolated main/investigator contexts with Athena-brokered read-only source tools and the **pi-ai** OpenAI Responses adapter. Main owns OAuth, protected storage, refresh, pinned model/registration, source permissions, evidence verification, and persistence. The shared Athena wrapper enforces subscription-compatible payloads and successful completed streams before tool execution. The separate connection utility uses **pi-ai** with only the explicitly saved DeepSeek key, fixed prompt, fixed HTTPS endpoint, capped output, no redirects/retries, and ignored stdio. It returns only numeric usage and a sanitized result category, never raw provider errors or keys. These packages are published under `@earendil-works`. DeepSeek paid work is possible only through the explicit test click and application cost gate, enforced by code rather than model instructions. A separate ChatGPT utility sends only the explicitly selected catalog model and fixed prompt using an OAuth access token. It shares the same Pi serialization/stream wrapper as conversations, without Pi login ownership or API-key fallback, and must observe a completed Responses stream. ChatGPT plan/credit usage is separate from DeepSeek's dollar accounting.
- **Process separation is not an OS filesystem sandbox.** The utility process is trusted application code and retains the host user's OS capabilities; it is not suitable for untrusted code. Folder consent and source/secret checks are enforced outside model instructions. ChatGPT Send authorizes eligible content and plan usage; it does not authorize protected environment/credential files or writes. DeepSeek's separate provider approval and dollar gate are unchanged.

For an isolated development profile (the directory is chosen by the launching user, never by the renderer):

```sh
npm run build
npm start -- --user-data-dir=/tmp/athena-demo-profile
```

To back up saved conversations, quit Athena first and copy the `state` directory. A full state backup also includes encrypted provider credentials; protect backups and do not share an active profile between installations. Do not delete it to troubleshoot rebuildable knowledge.

## Validation

```sh
npm run typecheck
npx vitest run tests/unit/conversations.test.ts
npx vitest run tests/unit/bridge.test.ts
npx vitest run tests/unit/supervisor.test.ts
npx vitest run tests/unit/inventory.test.ts
npx vitest run tests/unit/inventory-bridge.test.ts
npx vitest run tests/unit/model-settings.test.ts
npx vitest run tests/unit/model-bridge.test.ts
npm run test:desktop  # Builds and launches real Electron instances with temporary profiles
npm test             # Full unit + desktop suite, including typechecking/build
```

No provider account or live API key is required. Desktop tests use real SQLite, the actual preload bridge, and real Electron utility processes. Connection tests use fake keys, Electron safeStorage with Playwright's mock-Keychain backend, and a scripted HTTP provider boundary with the production Pi adapter; no live provider calls occur. They cover field clearing, ciphertext persistence, explicit testing, usage/cost display, authentication errors/redaction, lifecycle cancellation, and restart behavior. Model service tests additionally cover unknown/incomplete pricing, gate exhaustion across restart, timeouts, and cancellation with late results. They exercise unsaved drafts, first-send registration/model naming with a local fallback, delegated multi-repository investigation and separately retained exploration, failed-first-save retry, navigation during background progress, restart persistence, malicious payloads/callers, worker crashes, minimizing, close/quit cancellation, and recovery after forcibly terminating the app. Inventory tests use controlled real Git/filesystem fixtures and SQLite for consent persistence, ordinary/nested repositories, submodules/worktrees, aliases/moves, documentation hints, exclusions, symlink boundaries, non-Git files, overlapping roots, read-only discovery, and cancellation. Desktop inventory tests replace only the native picker, retaining the real preload, IPC, filesystem, and database. OS signals pause workers deterministically; no test-only execution or crash controls are exposed by the application. The supervisor tests additionally cover spawn failures, malformed output, deadlines, cancellation-before-spawn, stale results, and SQLite write failures during progress or completion. CI runs on macOS.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/main/conversations.ts` | Durable conversation transactions and interruption recovery |
| `src/main/bridge.ts` | Caller authorization and conversation request validation |
| `src/main/inventory.ts` | Local discovery, filesystem boundaries, stable repository identities, consent and inventory persistence |
| `src/main/inventory-bridge.ts` | Native folder selection/consent flow and validated inventory commands |
| `src/main/sources.ts`, `source-bridge.ts`, `source-tools.ts` | Shared bounded source access, persistent exceptions, validated UI commands, and Pi read-only tools |
| `src/main/secret-check.ts` | Heuristic full-file and final pre-send secret checks |
| `src/main/live-supervisor.ts` | Live job authority, source/credential broker, evidence checks, process supervision, deadlines, and lifecycle cancellation |
| `src/main/index.ts` | Electron lifecycle, security policies, SQLite location, protected storage, and utility process wiring |
| `src/main/model-settings.ts`, `model-bridge.ts` | Protected credential entry, provider permission, fixed-request consent, durable cost gate/results, validated settings commands |
| `src/main/deepseek-model.ts`, `connection-process.ts` | Athena-owned Pi-compatible model configuration and supervised connection transport |
| `src/preload.ts`, `src/shared/` | Narrow desktop interfaces, permission text, and shared types |
| `src/main/supervisor.ts`, `src/worker/demo.ts` | Legacy demonstration implementation; not connected to the live desktop send route |
| `src/worker/connection.ts`, `connection-exchange.ts` | Fixed bounded DeepSeek test using Pi, sanitized result/usage only |
| `src/main/chatgpt-*.ts`, `src/worker/chatgpt*.ts` | Protected OAuth, serialized refresh, catalog, revocation, narrow IPC, shared subscription Responses wrapper, and fixed-prompt test |
| `src/worker/live-agent.ts`, `live.ts`, `src/shared/live.ts` | Conversational orchestration, shared job/request accounting, cancellation, and narrow main/utility protocol |
| `src/worker/investigator.ts`, `title-tool.ts`, `agent-context.ts` | Isolated investigator lifecycle, model naming tool, and shared context safety/retention |
| `src/shared/investigation.ts` | Bounded findings schema, evidence validation, and exploration/result contracts |
| `src/renderer/` | Svelte conversation workspace and connection controls |
