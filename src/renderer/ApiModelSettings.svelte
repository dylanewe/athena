<script lang="ts">
  import { onMount } from 'svelte';
  import type { ApiSettingsSnapshot, ConversationRoute } from '../shared/api-models';
  let settings = $state<ApiSettingsSnapshot>();
  let error = $state('');
  let busy = $state(false);
  let route = $state<ConversationRoute>('chatgpt');
  let conversation = $state('');
  let investigator = $state('');
  let provider = $state('deepseek');
  let configInput = $state<HTMLTextAreaElement>();
  let credentialInput = $state<HTMLInputElement>();
  async function change(action: () => Promise<ApiSettingsSnapshot>) {
    if (busy) return;
    busy = true; error = '';
    try { settings = await action(); route = settings.route; conversation = settings.conversation; investigator = settings.investigator; }
    catch (failure) { error = failure instanceof Error ? failure.message : 'Could not save API-key settings.'; }
    finally { busy = false; }
  }
  function configure() {
    void change(() => { try { return window.athena.apiModels.configure(configInput!.value); } finally { configInput!.value = ''; } });
  }
  function credential() {
    void change(() => { try { return window.athena.apiModels.credential(provider, credentialInput!.value); } finally { credentialInput!.value = ''; } });
  }
  onMount(() => { void change(() => window.athena.apiModels.snapshot()); return () => { if (configInput) configInput.value = ''; if (credentialInput) credentialInput.value = ''; }; });
</script>

<section aria-label="API-key conversation configuration">
  <div class="eyebrow">Independent of Pi · No automatic requests</div>
  <h2>Conversation routes &amp; role models</h2>
  <p>ChatGPT conversations stay unchanged. API-key conversations use the provider’s paid API, not a subscription. Send authorizes one bounded job, including eligible repository content, investigation, and naming. The shared $1 application gate reserves every request conservatively; cancellation does not refund reservations or prevent already-incurred charges. It is not a provider billing limit.</p>
  {#if error}<p role="alert" class="problem">{error}</p>{/if}
  {#if settings}
    <form onsubmit={event => { event.preventDefault(); void change(() => window.athena.apiModels.select(route, conversation, investigator)); }}>
      <label>Route for new conversations
        <select bind:value={route} disabled={busy}><option value="chatgpt">ChatGPT plan (existing workflow)</option><option value="api-key">API key (paid provider API)</option></select>
      </label>
      <div class="roles">
        <label>Conversation model
          <select bind:value={conversation} disabled={busy}>{#each settings.models as model}<option value={model.ref}>{model.ref} · {model.name}</option>{/each}</select>
        </label>
        <label>Investigator model
          <select bind:value={investigator} disabled={busy}>{#each settings.models as model}<option value={model.ref}>{model.ref} · {model.name}</option>{/each}</select>
        </label>
      </div>
      <button disabled={busy}>Save route and role models</button>
    </form>
    <p class="meta">These settings affect new conversations only. Both roles’ complete configuration is pinned when a conversation begins. Credentials and permission can still be revoked. There is no automatic route, provider, or model fallback.</p>
    {#each settings.models.filter(model => model.ref === conversation || model.ref === investigator) as model}
      <div class="model-record"><strong>{model.ref}</strong><code>{model.endpoint}</code><span>{model.api} · Tools required · {model.reasoning ? 'Reasoning capable' : 'No reasoning'} · {model.contextWindow.toLocaleString()} context / {model.maxTokens.toLocaleString()} max output</span><span>USD / 1M: {model.cost.input} input · {model.cost.output} output · {model.cost.cacheRead} cache read · {model.cost.cacheWrite} cache write{model.cost.tiers?.length ? ' · Tiered pricing (gate uses highest rates)' : ''}</span></div>
    {/each}
    <h3>Provider &amp; endpoint permissions</h3>
    <p>Approval permits repository content at this exact destination, not folder access, secret access, or unattended paid work. A new provider, endpoint, API, or configured header policy requires a new approval. Connection tests do not grant it.</p>
    {#each settings.destinations as destination}
      <div class="destination"><span><strong>{destination.provider}</strong><code>{destination.endpoint}</code><small>Policy {destination.id.slice(0, 12)}</small></span><button disabled={busy} onclick={() => change(() => window.athena.apiModels.approveDestination(destination.id, !destination.approved))}>{destination.approved ? 'Revoke repository sending' : 'Approve repository sending'}</button></div>
    {/each}
    <h3>Protected credential sources</h3>
    <p>Pi precedence: saved credential → models.json apiKey → provider environment. Use a literal key, <code>$NAME</code> / <code>${'{NAME}'}</code> interpolation, or <code>!command</code>. Bare names are literals. Environment files in repositories are never read. Saved sources use macOS-protected storage; the field clears after submission.</p>
    <form onsubmit={event => { event.preventDefault(); credential(); }}>
      <label>API-key provider<select bind:value={provider} disabled={busy}>{#each settings.credentials as item}<option value={item.provider}>{item.provider}</option>{/each}</select></label>
      <label>Credential source<input type="password" bind:this={credentialInput} autocomplete="off" spellcheck="false" disabled={busy || !settings.protectedStorageAvailable} /></label>
      <button disabled={busy || !settings.protectedStorageAvailable}>Save protected credential</button>
    </form>
    {#each settings.credentials as item}<div class="destination"><span>{item.provider} · {item.revoked ? 'Revoked — all sources blocked' : item.stored ? 'Protected source saved' : 'Configuration / environment source'}</span><button disabled={busy} onclick={() => change(() => window.athena.apiModels.revokeCredential(item.provider))}>Revoke {item.provider} credentials</button></div>{/each}
    {#if !settings.protectedStorageAvailable}<p class="problem">Unlock macOS Keychain to save or use protected settings. No plaintext fallback.</p>{/if}
    <h3>Trusted credential helpers</h3>
    <p>Helpers run as you, outside repository directories, with a 10-second timeout and 8 KiB output limit. Review the exact command before approving; changed commands need fresh approval. Helpers are never agent tools. Revoking approval stops active API-key work.</p>
    {#each settings.helpers as helper}<div class="helper"><code>{helper.command}</code><button disabled={busy} onclick={() => change(() => window.athena.apiModels.approveHelper(helper.id, !helper.approved))}>{helper.approved ? 'Revoke helper approval' : 'Approve exact helper'}</button></div>{:else}<p class="meta">No credential helpers configured.</p>{/each}
    <details><summary>Import or replace Pi-compatible model configuration</summary>
      <p>Import is a one-time copy of the file you choose. Athena never follows Pi updates, repository .pi files, auth.json, instructions, extensions, or settings. Importing does not execute helpers or contact providers. Supported hosted APIs: OpenAI Completions, OpenAI Responses, Anthropic Messages. Unsupported fields and capabilities are rejected.</p>
      <p class="problem">Literal secrets in configuration files can leak through the original file or backups. Prefer environment references or approved secret-manager commands. Athena encrypts imported configuration and never redisplays its secret values.</p>
      {#if settings.literalWarning}<p class="problem">This configuration contains literal credential/header values. Prefer references; protect or remove the original source file.</p>{/if}
      <button disabled={busy} onclick={() => change(() => window.athena.apiModels.importModels())}>Import trusted models.json…</button>
      <form onsubmit={event => { event.preventDefault(); configure(); }}><label>Pi models.json (replace configuration)<textarea bind:this={configInput} rows="10" spellcheck="false" placeholder={'{"providers":{"deepseek":{"modelOverrides":{"deepseek-flash":{"name":"My DeepSeek"}}}}}'} disabled={busy}></textarea></label><button disabled={busy}>Validate and save configuration</button></form>
    </details>
  {/if}
</section>

<style>
  section { border-top: 1px solid var(--border); padding: 24px 0; }
  h2 { font-size: 20px; margin: 8px 0 12px; } h3 { margin-top: 28px; }
  label { display: grid; gap: 6px; margin: 12px 0; }
  select, textarea { width: 100%; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
  .roles { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .destination, .helper { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border); }
  code { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
  .destination code, .model-record > * { display: block; }
  .model-record { border-left: 2px solid var(--accent); padding: 8px 16px; margin: 16px 0; }
  .model-record span, .meta { font-size: 11px; color: var(--muted); }
  .problem { color: var(--error-text); } details { margin-top: 24px; } summary { cursor: pointer; }
  @media (max-width: 800px) { .roles { grid-template-columns: 1fr; } .destination, .helper { align-items: start; flex-direction: column; } }
</style>
