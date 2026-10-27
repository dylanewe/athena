# Athena

A personal macOS conversation workspace. This first slice ([#1](https://github.com/dylanewe/athena/issues/1)) saves conversations locally and runs a deterministic demonstration in a supervised Electron utility process. It does **not** investigate repositories or contact a model provider.

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

1. Choose **New conversation**, enter a name, and create it.
2. Send a message (or press **⌘ Enter**). Athena displays progress, then an explicitly labeled local demonstration response.
3. Create another conversation and switch between them in the sidebar.
4. Quit and reopen Athena: the selected conversation and saved messages return.
5. Send a message and close the window or quit before it finishes. Reopen to see the retained question and cancelled response. Minimizing does not cancel work. **Stop demonstration** cancels without closing the window.

There is one active demonstration at a time. Failed or timed-out jobs leave the workspace usable; send another message to retry. An abrupt application interruption is marked as cancelled on the next launch, not silently retried. Unsent drafts live only in the current window. If storage fails during a job, the process still stops and the UI offers **Retry saving**. Free disk space or resolve the storage problem, then retry; the terminal result is held in memory until saved. Quitting before that save succeeds leaves the already-persisted question recoverable as an interrupted job.

## State and safety

- Durable user state is SQLite at `~/Library/Application Support/Athena/state/conversations.sqlite` (including SQLite WAL/SHM sidecars while open). The selected conversation, messages, and job statuses are retained. State is **not encrypted**; treat the profile as private. The state directory is created owner-only and the database owner-readable/writable.
- Rebuildable repository knowledge is a separate concept and is not implemented. Clearing a future knowledge cache must not delete these conversations.
- The Svelte renderer is sandboxed, context-isolated, and has no Node.js, filesystem, or credential API. It renders messages as text, not HTML. CSP and Electron request filtering allow only built UI assets; navigation, popups, webviews, and permission requests are denied.
- The preload exposes only `workspace`, `create`, `select`, `send`, `cancel`, and change notifications. Main validates the owning window, main frame, exact document URL, operation, payload shape, IDs, and length bounds before accessing state.
- Electron starts a utility process only for a job, supplies an empty environment, and terminates it on completion, failure, timeout, or cancellation. Closing the last window quits the app. There is no investigation daemon, listening HTTP backend, analytics, or transcript upload.
- The utility process uses **pi-agent-core** and a deterministic **pi-ai** stream with no tools, provider credentials, or usable model endpoint. These packages are published under `@earendil-works`. No live model requests or paid work occur. This is enforced by application code, not by a system prompt.
- **Process separation is not an OS filesystem sandbox.** The utility process is trusted application code and retains the host user's OS capabilities; it is not suitable for untrusted code. Repository/environment permissions, credential handling, and paid-work consent need their own enforcement before live investigation is introduced.

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
npm run test:desktop  # Builds and launches real Electron instances with temporary profiles
npm test             # Full unit + desktop suite, including typechecking/build
```

No provider account or API key is required. Desktop tests use real SQLite, the actual preload bridge, and real Electron utility processes. They exercise restart persistence, malicious payloads/callers, worker crashes, minimizing, close/quit cancellation, and recovery after forcibly terminating the app. OS signals pause workers deterministically; no test-only execution or crash controls are exposed by the application. The supervisor tests additionally cover spawn failures, malformed output, deadlines, cancellation-before-spawn, stale results, and SQLite write failures during progress or completion. CI runs on macOS.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/main/conversations.ts` | Durable conversation transactions and interruption recovery |
| `src/main/bridge.ts` | Caller authorization and request validation |
| `src/main/supervisor.ts` | Job state, process failures, deadlines, and lifecycle cancellation |
| `src/main/index.ts` | Electron lifecycle, security policies, SQLite location, and utility process wiring |
| `src/preload.ts`, `src/shared/contracts.ts` | Narrow desktop interface and shared types |
| `src/worker/demo.ts` | Deterministic pi agent demonstration; no repository or provider access |
| `src/renderer/` | Svelte conversation workspace |
