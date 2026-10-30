# DeepSeek connection configuration

Athena owns its configuration in `src/main/deepseek-model.ts`, using Pi's `Model<'openai-completions'>` conventions. Its initial provider/model metadata is copied into the local `models.sqlite` on first launch and retained, not refreshed from Pi's catalog. No Pi auth files, repository credentials, shell keys, OAuth, subscriptions, or local endpoints are imported. Only `deepseek` / `deepseek-flash` / `openai-completions` is supported in this slice; incompatible saved configuration is rejected, never silently switched.

## Verified metadata — 2026-10-29

Primary sources consulted during implementation:

- [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing): `deepseek-flash`, currently **DeepSeek-V4.1-Flash-1017**; 1M context, maximum 384K output, text/image input, tool calls and JSON output supported. Endpoint: `https://api.deepseek.com` (OpenAI format).
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode): thinking is normally enabled by default; explicitly disable it for this small connectivity exchange with `thinking: {type: "disabled"}`.
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage): macOS uses a Keychain-backed encryption key. Athena stores only the resulting ciphertext in SQLite and refuses credential operations when protected storage is unavailable or the platform is not macOS. This protects the credential at rest, not against other software already running as the user.

Configured prices are USD per million tokens, using **peak** rates at all hours:

| Input (cache miss) | Output | Cache read | Cache write |
| --- | --- | --- | --- |
| $0.30 | $1.20 | $0.006 | $0 (not separately billed) |

DeepSeek currently offers half-price off-peak rates. Athena deliberately does not assume a discount or cache savings when reserving cost. Provider prices and the model behind a provider-managed ID can change independently of Athena; these are configured estimates, not a billing guarantee. Updating or changing Athena's selected model is not automatic.

## Explicit test contract

**Test connection** authorizes a single potentially paid request. Only `Reply with exactly: Athena connection OK` is sent as one user message. No system prompt, transcript, repository material, tools, images, or other secrets are included. The API key is sent only as provider authentication, never model context.

The test has a 32-output-token cap, thinking disabled, a 20-second application deadline, no automatic retries, and a fixed HTTPS endpoint with redirects denied. An Electron utility process receives just the entered credential, with an empty environment and ignored stdio. The main process kills it after completion, failure, cancellation, timeout, renderer failure, window close, or quit. Minimizing does not cancel. This trusted utility process is **not an OS filesystem sandbox**.

Main receives only a success/failure category and numeric reported usage, not raw model text, errors, headers, or credentials. Provider errors are discarded and replaced by application-authored messages. Usage cost is calculated at configured rates; it is not authoritative billing. Missing reported usage is treated as a failed test, not fabricated as zero-cost success.

## Application cost gate

The user approved a persistent, application-wide **$1 gate** for this implementation. There is no disabling, resetting, or budget-increase control in this slice.

Before spawning any request, persist its conservative reservation in SQLite. Unknown, incomplete, negative, or invalid pricing blocks the request; a reservation that cannot fit the remaining gate blocks it too. Use an allowance of 1,024 input tokens (well above the fixed ASCII prompt and protocol overhead) and the 32-token output cap at peak/no-cache-savings rates. Current reservation: **$0.00034560 per test**. Integer nano-USD accounting avoids accumulating floating-point budget error.

All reservations are retained, even on success, failed authentication, spawn failure, cancellation, timeout, or abrupt interruption. This is deliberately conservative: an already-sent canceled request can still incur charges. Relaunching, replacing a key, or changing provider permission does not replenish the gate. Interrupted tests are marked canceled on restart and are never retried automatically. A failure to persist the reservation prevents sending.

## Separate provider permission

A connection test or saved key never implies approval to upload repository material. **Save provider approval** records the exact permission text and acceptance timestamp independently; **Revoke provider approval** removes it. No DeepSeek repository upload path exists here. A future DeepSeek investigation slice must enforce this approval plus folder/environment/secret permissions and paid-work consent in application code before sending any content. The separate [ChatGPT conversation route](live-conversations.md) uses Send as its plan-use/content authorization without an additional provider checkbox; it never inherits or activates this API-key billing route.

## Deterministic validation

Service tests exercise real SQLite with a scripted OS-protection boundary and scripted providers, including the real Pi wire adapter against controlled HTTP responses. Desktop tests use Electron's `safeStorage` API (with Playwright's mock-Keychain backend), preload IPC, SQLite, and the actual connection utility worker. They verify ciphertext persistence, not real login-Keychain integration. They replace only the worker's HTTP boundary from the test harness, not a production test switch. Keys are fake; automated tests never require live credentials or call DeepSeek. They verify usage, authentication failure, no automatic requests, cancellation/lifecycle, ciphertext at rest, field clearing, caller validation, and safe error output.
