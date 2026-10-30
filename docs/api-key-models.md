# Pi-compatible API-key configuration (#6)

## Compatibility and scope

Athena pins `@earendil-works/pi-ai` **1.4.0** and `@earendil-works/pi-agent-core` **1.4.0** (exact dependencies and lockfile). The configuration contract follows Pi coding-agent **1.4.0** `model-config`, `provider-composer`, and `resolve-config-value` conventions. No coding-agent runtime is installed or invoked. Metadata/compatibility schemas come directly from the pinned pi-ai package, not a reduced Athena model format. See Pi's [models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md) and [providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) documentation; upstream main may evolve beyond this pinned version.

Supported hosted API-key transports are `openai-completions`, `openai-responses`, and `anthropic-messages`, including compatible HTTPS endpoints with explicit metadata. Unsupported APIs, OAuth/subscription configuration, local endpoints, extensions, routing/fallback policies, and unknown fields/capabilities are rejected, not ignored. Existing ChatGPT subscription conversations, registration pinning, refresh and billing remain separate and unchanged. Athena never changes a route in response to a failure.

## Workflow

In **Model settings → Conversation routes & role models**:

1. The existing ChatGPT route remains selected until you explicitly choose **API key (paid provider API)** and save. Both API-key roles initially select Athena's verified `deepseek/deepseek-flash`; this is not an automatic paid request or an implicit switch from ChatGPT.
2. Choose conversation and investigator models independently. Save a protected credential source for each provider, or configure its Pi-compatible source. Saving configuration, keys, selections or approvals performs no provider requests and executes no helpers.
3. Review and explicitly **Approve repository sending** for each exact provider/destination policy. This is separate from folder/environment/secret access and from paid-work authorization. The old fixed DeepSeek test's provider permission does **not** transfer to this route. Provider, normalized HTTPS endpoint (including path/port), API, authentication-header mode, and configured header references bind approval. Changing any of those requires new approval; replacing a key alone does not.
4. A conversation's first Send pins **both complete non-secret role/provider configurations**, including endpoint, metadata, pricing, compatibility and sampling defaults, plus immutable opaque references to protected configuration sources. Settings edits affect **new conversations only**, not subsequent jobs or explicit retries of an existing conversation. Each job takes a copy of that pinned configuration. Existing ChatGPT histories never transfer to this route. Switching the default back to ChatGPT does not change API-key conversations.
5. Send authorizes potentially paid API work, source transmission, investigation and naming within the existing shared 50-request/15-minute job bounds. Each API request additionally has a **1,024-output-token cap**, a 20-second transport timeout, no SDK/wrapper retries, and an 8 MiB response limit. Model failures never start another request or provider fallback. Folder/source permissions, secret checks, evidence provenance, isolated investigator context and naming behavior use the existing shared boundaries.
6. Credential, helper or destination revocation stops active API-key work through the UI gateway and blocks later grants, including old conversations. Already-sent requests cannot be recalled and may incur usage. Revoking unrelated API-key authority conservatively stops the active API-key job, never a ChatGPT job.

## Model configuration and explicit import

**Import trusted models.json…** opens a native file picker and copies only the chosen file into Athena-owned protected SQLite. It does not import adjacent `auth.json`, settings, instructions, extensions, skills, or project resources. No import, Pi discovery, model discovery or network refresh occurs at launch. Files under designated source roots and project `.pi/models.json` are rejected. A user-global `~/.pi/agent/models.json` or separately chosen trusted user configuration is allowed; custom Pi directories need no environment setting. Later changes to the original file have no effect.

The replacement editor accepts the same `providers` object as Pi's `models.json`, with JSON comments and BOM support. It clears on submission and never redisplays imported secrets. `models` adds/replaces same-ID builtins; `modelOverrides` merges metadata into existing models. Overrides preserve partial costs, nested image limits, compatibility values, sampling defaults and per-thinking-level sampling maps. Definitions inherit only API/endpoint defaults, not same-ID model metadata. The bundled static Pi catalog is read offline; no mutable Pi catalog cache is consulted. Athena's previously verified DeepSeek Flash metadata remains its explicit default.

Example (a provider override, not a new reduced model schema):

```json
{
  "providers": {
    "deepseek": {
      "apiKey": "$DEEPSEEK_API_KEY",
      "modelOverrides": {
        "deepseek-flash": {
          "name": "My Flash",
          "cost": { "output": 1.2 }
        }
      }
    }
  }
}
```

For custom `models` entries supply verified `api`, `baseUrl`, `reasoning`, `input` including text, positive integer `contextWindow`, `maxTokens` of at least 1024, and complete `cost` input/output/cacheRead/cacheWrite rates. Pi's optional tier prices are supported; budgeting uses the highest rates. Athena deliberately requires this metadata rather than accepting Pi's unknown-price zero defaults. Cap-incompatible endpoints, routing/fallback policies, and sampling defaults that override routing, model, tools or output caps are rejected. Unknown override IDs and duplicate definitions are errors rather than silently ignored. Missing selected models stay invalid; configuration edits do not select replacements or change billing routes. Errors are application-authored and never echo invalid JSON, credentials, native errors or provider bodies.

## Credentials and helpers

Resolution follows Pi 1.4.0 precedence: **protected stored provider credential → pinned models.json apiKey → built-in provider's API-key environment variable**. Athena exposes no runtime key override. Supported conventional variables are declared in `api-settings.ts`; custom providers should supply `apiKey` or a protected source. There is no ambient cloud credential, OAuth, subscription, `.env`, or repository credential resolver.

Values use Pi's literal/template/command syntax:

- Literal keys remain literals. A bare `MY_KEY` is **not** an environment reference.
- `$NAME` and `${NAME}` interpolate the launch environment; references may occur inside a larger string. Missing/empty variables fail without falling through to another source. `$$` escapes `$`; `$!` escapes `!`.
- A leading `!` executes the rest as a trusted user credential command. Command stdout is trimmed; empty output, error, cancellation or excess output fails without fallback. Stored-auth helper results (including failures) are cached for the process lifetime; models.json key/header helpers execute at request time without that cache, matching Pi's distinction. Source replacement/revocation clears the auth cache.
- Header values use the same resolution and explicit helper approval. They remain in protected storage, not conversation context. Unsafe transport header names and credential control characters are rejected.

Each exact helper requires an explicit approval **before its first execution**; a changed command has a different approval identity. The helper is not an agent-callable shell tool and receives no model-controlled arguments. It runs under `/bin/sh -c` in Athena's private state directory (not a repository), with the launch environment but no shell startup-file hooks, ignored stdin/stderr, a 10-second timeout and an 8 KiB stdout limit. Cancellation kills its process group; errors/logs never include command output or raw exceptions. Approved helpers are trusted code with the user's OS permissions, not an OS sandbox; a deliberately malicious helper can escape process-group limits or read files itself. Review commands carefully, especially if they contain literal secrets. Helpers can access credentials/environment as the user, but never grant models permission to do so.

UI-entered sources and the whole imported configuration use macOS Keychain-backed `safeStorage` encryption in owner-only `api-models.sqlite`, with full synchronization, delete journaling and secure deletion. There is no plaintext storage fallback. Original configuration files and backups remain the user's responsibility; the UI warns about literal secrets. Password/editor fields clear synchronously after submission, including errors. Resolved keys/headers are released only as request-scoped worker authority; they do not enter model context, conversation bindings, renderer snapshots, provider errors or logs. Conversation history/source excerpts remain unencrypted personal data, as before.

**Revoke provider credentials** blocks every source for that provider, including configuration/environment fallback in pinned conversations. Saving a new protected source explicitly re-enables it. Permission/helper approval is rechecked after asynchronous resolution and before each request grant; replacing a source mid-resolution invalidates the old result.

## Shared paid-work gate

The pre-existing persistent **$1 application cost gate** now covers all API-key requests and the fixed DeepSeek tests. ChatGPT plan usage remains outside dollar accounting. Before releasing each API request's credentials, main durably reserves input allowance and capped output at the pinned maximum input/cache/output prices, including tier rates. Input allowance is six times serialized Pi context bytes plus 16,384 bytes for protocol expansion; the worker checks the actual final serialized payload fits that allowance (and any smaller configured request-byte limit). One token per allowed byte is deliberately conservative, not a tokenizer claim. The output cap is verified on the actual payload. Missing/invalid prices, exhausted gate, failed persistence or excessive payload prevents sending. Reservations are never refunded, including failures, cancellations and abrupt shutdowns; settings/import/restart cannot replenish them. There is no reset or budget-increase control.

The gate is an application estimate, **not an authoritative provider billing cap**. Configured rates may be stale or incorrect; no software-side estimate can guarantee the provider's bill. Token totals are displayed only when actual numeric usage is observed, never invented from Pi's default zero placeholders.

## Deterministic evidence

- `api-settings.test.ts`: Pi metadata/overrides, validation without state mutation, explicit import isolation, encrypted credentials, exact endpoint consent, pinning/restart, credential precedence/templates, helper approval/change/cache/cancellation/redaction, and shared gate exhaustion.
- `api-conversations.test.ts`: real pi-agent-core agents + real Pi Completions adapter against scripted HTTP, independent role providers, source/evidence boundaries, pinned settings across in-flight edits/later jobs, new-conversation changes, revocation and no retry/fallback.
- `api-models.spec.ts`: real Electron UI/preload/main/utility and safeStorage (Playwright mock Keychain), explicit routing/consent, protected-entry clearing, worker request caps, durable pinning/revocation, one-time import and invalid capability errors. Only native picker and HTTP are scripted; no production test controls or live credentials.

No live model calls were made for #6. Real Keychain integration and provider billing are not established by mock-Keychain/scripted tests.
