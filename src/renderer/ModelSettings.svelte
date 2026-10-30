<script lang="ts">
  import { onMount } from 'svelte';
  import ChatGPTSettings from './ChatGPTSettings.svelte';
  import ApiModelSettings from './ApiModelSettings.svelte';
  import { CONNECTION_MAX_TOKENS, CONNECTION_PROMPT, CONNECTION_TIMEOUT_MS, PROVIDER_CONSENT, type ModelWorkspace } from '../shared/models';

  let settings = $state<ModelWorkspace | null>(null);
  let error = $state('');
  let busy = $state(false);
  let accepted = $state(false);
  let keyInput = $state<HTMLInputElement>();
  let requestNumber = 0;
  const running = $derived(settings?.test.status === 'running');
  const canAfford = $derived(settings?.gate.estimateUsd !== null && settings &&
    settings.gate.reservedUsd + settings.gate.estimateUsd! <= settings.gate.limitUsd);
  const usd = (value: number) => '$' + value.toFixed(8);

  async function load() {
    if (busy) return;
    const number = ++requestNumber;
    try {
      const next = await window.athena.models.snapshot();
      if (number === requestNumber) settings = next;
    } catch { error = 'Could not load model settings. Check local storage and restart Athena.'; }
  }
  async function change(action: () => Promise<ModelWorkspace>) {
    if (busy) return;
    busy = true;
    error = '';
    ++requestNumber;
    try { settings = await action(); }
    catch (failure) { error = failure instanceof Error ? failure.message : 'Could not save model settings. Retry the operation.'; }
    finally { busy = false; void load(); }
  }
  function saveKey() {
    if (!keyInput || busy) return;
    void change(() => {
      try { return window.athena.models.saveKey(keyInput!.value); }
      finally { keyInput!.value = ''; }
    });
  }
  onMount(() => {
    const unsubscribe = window.athena.onChange(() => { void load(); });
    void load();
    return () => { unsubscribe(); if (keyInput) keyInput.value = ''; };
  });
</script>

<main>
  <header>
    <div><div class="eyebrow">A deliberate connection</div><h1>Model settings</h1></div>
    <span class="demo-badge">No automatic requests</span>
  </header>
  <div class="settings-content">
    <p class="intro">Choose when Athena contacts a model. Route and role selections for new conversations are independent of the fixed DeepSeek connection test below. Connection testing never includes repository material.</p>
    {#if error}<div class="settings-error" role="alert">{error}</div>{/if}
    {#if settings}
      <section aria-label="Selected model">
        <div class="eyebrow">Selected provider · {settings.model.provider}</div>
        <h2>{settings.model.name}</h2>
        <code>{settings.model.id}</code>
        <dl class="capabilities">
          <div><dt>Tool calling</dt><dd>{settings.model.toolCalls ? 'Supported' : 'Not supported'} · No tools in this test</dd></div>
          <div><dt>Reasoning</dt><dd>{settings.model.reasoning ? 'Supported' : 'Not supported'} · Disabled for this test</dd></div>
          <div><dt>Input</dt><dd>{settings.model.input.join(', ')} · Text-only test</dd></div>
          <div><dt>Context / max output</dt><dd>{settings.model.contextWindow.toLocaleString()} / {settings.model.maxTokens.toLocaleString()} tokens</dd></div>
        </dl>
        <p class="meta">{settings.model.api} · Pinned by Athena, never auto-switched · Metadata verified {settings.model.verifiedAt}</p>
        {#if settings.model.cost}
          <div class="pricing" role="group" aria-label="Configured pricing">
            <span class="eyebrow">Configured peak USD per 1M tokens</span>
            <dl>
              <div><dt>Input</dt><dd>${settings.model.cost.input}</dd></div>
              <div><dt>Output</dt><dd>${settings.model.cost.output}</dd></div>
              <div><dt>Cache read</dt><dd>${settings.model.cost.cacheRead}</dd></div>
              <div><dt>Cache write</dt><dd>${settings.model.cost.cacheWrite}</dd></div>
            </dl>
          </div>
        {/if}
      </section>

      <section aria-label="Protected credential">
        <h2>DeepSeek API key</h2>
        <p>Stored with macOS Keychain-backed encryption. Athena does not import Pi, shell, or repository credentials. The entry field is cleared on submission, including errors.</p>
        {#if !settings.protectedStorageAvailable}
          <div class="settings-error" role="alert">macOS protected storage is unavailable. Unlock your login Keychain and retry; keys cannot be saved as plaintext.</div>
        {/if}
        <form onsubmit={event => { event.preventDefault(); saveKey(); }}>
          <label for="deepseek-key">DeepSeek API key</label>
          <div class="key-entry">
            <input id="deepseek-key" type="password" bind:this={keyInput} autocomplete="off" spellcheck="false" maxlength="512" placeholder="Enter or replace a key" disabled={busy || running || !settings.protectedStorageAvailable} />
            <button disabled={busy || running || !settings.protectedStorageAvailable}>Save key</button>
          </div>
        </form>
        <p class="meta">{settings.credentialConfigured ? 'Key saved in macOS-protected storage.' : 'No key configured. Save a DeepSeek API key before testing.'}</p>
      </section>

      <section aria-label="Connection test">
        <h2>Test connection</h2>
        <p>Clicking <strong>Test connection</strong> authorizes one potentially paid request to DeepSeek with only this prompt:</p>
        <blockquote>{CONNECTION_PROMPT}</blockquote>
        <p class="meta">Maximum {CONNECTION_MAX_TOKENS} output tokens · {CONNECTION_TIMEOUT_MS / 1000}s timeout · No tools, repository content, conversation history, automatic retries, or other provider requests.</p>
        <div class="cost-gate" role="group" aria-label="Application cost gate">
          <div class="eyebrow">$1 application cost gate · Always enabled</div>
          <dl>
            <div><dt>Reserved since setup</dt><dd>{usd(settings.gate.reservedUsd)} / $1.00</dd></div>
            <div><dt>Conservative next test</dt><dd>{settings.gate.estimateUsd === null ? 'Unknown — request blocked' : usd(settings.gate.estimateUsd)}</dd></div>
          </dl>
          <p>Reservations persist across restarts and are not refunded, including failed or canceled tests. Estimates use a 1,024-input-token allowance, capped output, and peak rates without cache savings.</p>
        </div>
        {#if settings.gate.estimateUsd === null}
          <div class="settings-error" role="alert">Pricing is missing or invalid. Update Athena's model configuration with verified prices before testing. No request will be sent.</div>
        {:else if !canAfford}
          <div class="settings-error" role="alert">The next estimate cannot fit the remaining $1 application cost gate. Further requests are blocked.</div>
        {/if}
        <div class="actions">
          {#if running}
            <button disabled={busy} onclick={() => change(() => window.athena.models.cancel())}>Cancel connection test</button>
          {:else}
            <button class="primary" disabled={busy || !settings.credentialConfigured || !settings.protectedStorageAvailable || !canAfford} onclick={() => change(() => window.athena.models.test())}>Test connection</button>
          {/if}
        </div>
        <p role="status" aria-live="polite" class:problem={settings.test.status === 'failed'}>{settings.test.message}</p>
        {#if settings.test.usage}
          <div class="usage" role="group" aria-label="Reported usage">
            <span class="eyebrow">Provider-reported tokens</span>
            <p>{settings.test.usage.input} input · {settings.test.usage.output} output · {settings.test.usage.cacheRead} cache read · {settings.test.usage.cacheWrite} cache write</p>
            <span class="eyebrow">Estimated cost at configured rates</span>
            <p class="amount">{usd(settings.test.estimatedCostUsd!)}</p>
          </div>
        {/if}
        <p class="meta">This is an application-side estimate and gate, not an authoritative provider billing limit. Provider prices and billing may differ. An already-sent canceled request may still incur charges.</p>
      </section>

      <section aria-label="Provider permission">
        <h2>Repository provider permission</h2>
        <p>A successful connection test does not approve repository uploads. Provider approval is separate from folder, environment, secret, and paid-work permissions. This legacy DeepSeek test permission does not authorize the API-key conversation route; approve its exact endpoint below.</p>
        {#if settings.providerConsent}
          <p>{settings.providerConsent.text}</p>
          <p class="meta">Approved {new Date(settings.providerConsent.acceptedAt).toLocaleString()}</p>
          <button disabled={busy} onclick={() => change(() => window.athena.models.revokeConsent())}>Revoke provider approval</button>
        {:else}
          <p>{PROVIDER_CONSENT}</p>
          <label class="check"><input type="checkbox" bind:checked={accepted} /> I approve the provider permission</label>
          <button disabled={busy || !accepted} onclick={() => change(() => window.athena.models.consent(PROVIDER_CONSENT))}>Save provider approval</button>
        {/if}
      </section>
    {:else}
      <p class="meta">Loading model settings…</p>
    {/if}
    <ApiModelSettings />
    <ChatGPTSettings />
  </div>
</main>

<style>
  .settings-content { overflow-y: auto; padding: 24px 36px 40px; font-size: 13px; line-height: 1.7; }
  .intro { color: var(--muted); margin: 0 0 24px; max-width: 660px; }
  section { padding: 24px 0; border-top: 1px solid var(--border); }
  section:first-of-type { border-top: none; padding-top: 0; }
  h2 { font-size: 20px; letter-spacing: -.4px; margin: 0 0 12px; }
  .eyebrow + h2 { margin-top: 8px; }
  code, dd, .amount { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; }
  code { color: var(--accent); }
  dl { margin: 12px 0; }
  dl > div { display: flex; justify-content: space-between; gap: 16px; padding: 5px 0; }
  dt, .meta { color: var(--muted); }
  dd { margin: 0; text-align: right; }
  .meta { font-size: 11px; }
  .key-entry, .actions { display: flex; gap: 12px; }
  .key-entry input { min-width: 0; }
  .key-entry button { flex-shrink: 0; }
  blockquote { margin: 16px 0; border-left: 2px solid var(--accent); padding: 12px 16px; background: var(--surface); font-family: 'SFMono-Regular', Consolas, monospace; }
  .pricing, .cost-gate { margin: 20px 0; padding: 16px 20px; background: var(--surface); border-radius: 7px; }
  .pricing dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; }
  .cost-gate { border: 1px solid var(--accent); background: var(--accent-surface); }
  .cost-gate p { color: var(--muted); font-size: 11px; margin-bottom: 0; }
  .check { display: flex; align-items: center; gap: 10px; font-size: 13px; margin: 16px 0; }
  .check input { width: auto; }
  .usage { border-left: 2px solid var(--accent); padding-left: 16px; margin: 20px 0; }
  .usage p { margin: 4px 0 14px; }
  .settings-error { padding: 12px; background: var(--error-surface); color: var(--error-text); border-radius: 6px; margin: 12px 0; }
  .problem { color: var(--error-text); }
  @media (max-width: 800px) {
    .settings-content { padding: 22px; }
    dl > div { flex-wrap: wrap; gap: 0 12px; }
    dd { text-align: left; }
    .pricing dl { grid-template-columns: 1fr; }
  }
</style>
