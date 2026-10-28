# Athena

A personal macOS investigation workspace. Conversations persist locally with a deterministic demonstration ([#1](https://github.com/dylanewe/athena/issues/1)); designated folders provide a local repository inventory ([#2](https://github.com/dylanewe/athena/issues/2)). Discovery does **not** analyze source code, contact model providers, or incur model charges.

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

1. Choose **New conversation**. A title appears above the focused chatbox—there is no naming form, and nothing is saved or added to the sidebar yet.
2. Send your first message (or press **⌘ Enter**). Athena atomically saves the conversation and first prompt, derives a local title, and adds the conversation to the sidebar. It displays progress, then an explicitly labeled local demonstration response.
3. Start another conversation and switch between sent conversations in the sidebar. An unsent new draft stays in the current window when you switch conversations or visit Repositories.
4. Quit and reopen Athena: the selected conversation and saved messages return.
5. Send a message and close the window or quit before it finishes. Reopen to see the retained question and cancelled response. Minimizing does not cancel work. **Stop demonstration** cancels without closing the window.

Titles currently use a whitespace-normalized excerpt of the first prompt, limited to 100 Unicode code points with an ellipsis when needed. Later messages do not change the title, and previously saved names remain intact. This is a temporary local fallback, not model-generated naming; model-derived titles are tracked with live integration in [#5](https://github.com/dylanewe/athena/issues/5). No title-generation provider call or charge occurs. If the first save fails, the draft remains available to retry and no empty sidebar session is created.

There is one active demonstration at a time. Failed or timed-out jobs leave the workspace usable; send another message to retry. An abrupt application interruption is marked as cancelled on the next launch, not silently retried. Unsent drafts live only in the current window. If storage fails during a job, the process still stops and the UI offers **Retry saving**. Free disk space or resolve the storage problem, then retry; the terminal result is held in memory until saved. Quitting before that save succeeds leaves the already-persisted question recoverable as an interrupted job.

## Designate a folder

1. Choose **Repositories → Choose folder**. The native macOS picker selects a directory; Athena displays its canonical path before accessing its contents.
2. Review the permission, check **I understand the folder permission**, then **Save consent and discover**. Consent covers eligible material throughout that folder, including future repositories and non-Git documents. It is saved locally with the exact permission text and acceptance time. It does **not** approve providers, secrets, environment access, or paid work.
3. Discovery finds ordinary Git repositories, nested repositories, submodules, and worktrees. Contents belong to the nearest discovered repository; nested repositories have separate inventory entries. Non-Git files remain eligible and are counted separately. All repositories are **Unexamined**: file counts and directory discovery are not model analysis or runtime tracing.
4. Names default to directory names. When a name collides (case-insensitive, Unicode-normalized), choose a unique alias. Missing repositories retain their identities. After a move or rename, rescan the designated folders (or designate the new enclosing folder); explicitly reconnect the discovered location to its original name, or register it as a new repository. Reconnection preserves the original name/alias and documentation hints; nothing is automatically merged.
5. Configure **Documentation starting directories** per repository, one relative path per line. `docs` is the default; additional or not-yet-created directories are allowed. These are prioritization hints, not content access limits.
6. Use **Cancel discovery** to stop traversal and retain partial results, or **Rescan folders** to retry. Missing/unreadable locations and failures are visible; unchecked locations are not silently treated as missing. On launch, saved roots are rediscovered locally. Closing/quitting cancels discovery; minimizing does not.

Hidden directories, dependencies (`node_modules`, `vendor`, `vendors`, `bower_components`, `venv`, `env`, `Pods`, `Carthage`), and build outputs (`dist`, `build`, `out`, `target`, `coverage`, `__pycache__`) are skipped by default. Use **Include and rescan** with a relative directory to override a skip. Ancestors needed to reach that location are traversed without including their other skipped contents; descendants still use default exclusions. Directory symlinks are not followed, even when explicitly included; Git metadata (`.git`) cannot be included. Worktree/submodule gitfiles are recognized without following their target, which can live outside the designated folder. Nested/overlapping designated roots do not duplicate content.

Repository inventory organizes knowledge; it is not per-repository authorization. No manifest or cross-repository opaque ID is required. Discovery reads directory entries and bounded Git pointer files, never invokes Git or executes repository code, and never writes investigated repositories. Boundary checks reject symlink paths and recheck persisted roots; this is trusted application filesystem traversal, **not an OS sandbox against hostile concurrent filesystem mutation**. Future investigation must validate permissions again when opening material; this inventory is not a reusable filesystem-access capability.

## State and safety

- Durable user state is SQLite under `~/Library/Application Support/Athena/state/`: `conversations.sqlite` retains selection, messages, and job statuses; `inventory.sqlite` retains folder consent, explicit includes, repository names/locations, unresolved candidates, and documentation hints (with SQLite WAL/SHM sidecars while open). Inventory observations are refreshed on discovery; they are not analyzed knowledge. State is **not encrypted**; treat the profile as private. The state directory is created owner-only and both databases owner-readable/writable.
- Rebuildable repository knowledge is a separate concept and is not implemented. Clearing a future knowledge cache must not delete these conversations.
- The Svelte renderer is sandboxed, context-isolated, and has no Node.js, filesystem, or credential API. It renders messages as text, not HTML. CSP and Electron request filtering allow only built UI assets; navigation, popups, webviews, and permission requests are denied.
- The preload exposes conversation `workspace`, `select`, `send`, and `cancel` operations, a narrow `inventory` interface, and change notifications. Sending with a null conversation ID creates a conversation and its first message in one transaction; there is no separate empty-conversation creation API. Inventory supports snapshot, native folder selection/consent/dismissal, scan/cancel, explicit includes, registration/reconnection, and documentation hints—never arbitrary filesystem reads or IPC. Main validates the owning window, main frame, exact document URL, operation, payload shape, IDs/names, and length bounds. Only a pending native picker selection with the exact displayed permission text can designate a root.
- Electron starts a utility process only for a job, supplies an empty environment, and terminates it on completion, failure, timeout, or cancellation. Closing the last window quits the app. There is no investigation daemon, listening HTTP backend, analytics, or transcript upload.
- The utility process uses **pi-agent-core** and a deterministic **pi-ai** stream with no tools, provider credentials, or usable model endpoint. These packages are published under `@earendil-works`. No live model requests or paid work occur. This is enforced by application code, not by a system prompt.
- **Process separation is not an OS filesystem sandbox.** The utility process is trusted application code and retains the host user's OS capabilities; it is not suitable for untrusted code. Folder consent is enforced outside model instructions; environment/secret permissions, provider approval, and paid-work consent still need separate enforcement before live investigation is introduced.

For an isolated development profile (the directory is chosen by the launching user, never by the renderer):

```sh
npm run build
npm start -- --user-data-dir=/tmp/athena-demo-profile
```

To back up saved conversations, quit Athena first and copy the `state` directory. Do not delete it to troubleshoot rebuildable knowledge.

## Validation

```sh
npm run typecheck
npx vitest run tests/unit/conversations.test.ts
npx vitest run tests/unit/bridge.test.ts
npx vitest run tests/unit/supervisor.test.ts
npx vitest run tests/unit/inventory.test.ts
npx vitest run tests/unit/inventory-bridge.test.ts
npm run test:desktop  # Builds and launches real Electron instances with temporary profiles
npm test             # Full unit + desktop suite, including typechecking/build
```

No provider account or API key is required. Desktop tests use real SQLite, the actual preload bridge, and real Electron utility processes. They exercise unsaved drafts, first-send registration/local naming, failed-first-save retry, navigation during background progress, restart persistence, malicious payloads/callers, worker crashes, minimizing, close/quit cancellation, and recovery after forcibly terminating the app. Inventory tests use controlled real Git/filesystem fixtures and SQLite for consent persistence, ordinary/nested repositories, submodules/worktrees, aliases/moves, documentation hints, exclusions, symlink boundaries, non-Git files, overlapping roots, read-only discovery, and cancellation. Desktop inventory tests replace only the native picker, retaining the real preload, IPC, filesystem, and database. OS signals pause workers deterministically; no test-only execution or crash controls are exposed by the application. The supervisor tests additionally cover spawn failures, malformed output, deadlines, cancellation-before-spawn, stale results, and SQLite write failures during progress or completion. CI runs on macOS.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/main/conversations.ts` | Durable conversation transactions and interruption recovery |
| `src/main/bridge.ts` | Caller authorization and conversation request validation |
| `src/main/inventory.ts` | Local discovery, filesystem boundaries, stable repository identities, consent and inventory persistence |
| `src/main/inventory-bridge.ts` | Native folder selection/consent flow and validated inventory commands |
| `src/main/supervisor.ts` | Job state, process failures, deadlines, and lifecycle cancellation |
| `src/main/index.ts` | Electron lifecycle, security policies, SQLite location, and utility process wiring |
| `src/preload.ts`, `src/shared/` | Narrow desktop interfaces, permission text, and shared types |
| `src/worker/demo.ts` | Deterministic pi agent demonstration; no repository or provider access |
| `src/renderer/` | Svelte conversation workspace |
