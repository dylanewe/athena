<script lang="ts">
  import { onMount } from 'svelte';
  import { CHATGPT_PROMPT, type ChatGPTSnapshot } from '../shared/chatgpt';
  let settings = $state<ChatGPTSnapshot | null>(null);
  let error = $state('');
  let busy = $state(false);
  let revision = 0;
  const active = $derived(settings?.activity !== 'idle');
  const ready = $derived(settings?.account?.planEnabled && settings.models.some(model => model.id === settings?.selectedModel));
  async function load() {
    if (busy) return;
    const current = ++revision;
    try { const next = await window.athena.chatgpt.snapshot(); if (current === revision) settings = next; }
    catch { error = 'Could not load ChatGPT settings. Check local storage and restart Athena.'; }
  }
  async function change(action: () => Promise<ChatGPTSnapshot | void>) {
    if (busy) return;
    busy = true; error = ''; ++revision;
    try { const next = await action(); if (next) settings = next; }
    catch (failure) { error = failure instanceof Error ? failure.message : 'ChatGPT action failed. Retry explicitly when ready.'; }
    finally { busy = false; void load(); }
  }
  onMount(() => {
    void load();
    return window.athena.onChange(() => { void load(); });
  });
</script>

<section class="chatgpt" aria-label="ChatGPT subscription connection">
  <div class="eyebrow">Separate billing route · No API key</div>
  <h2>Use your ChatGPT plan</h2>
  <p>Connect one ChatGPT account for live conversations and read-only investigation. Sending a question authorizes eligible content from your globally designated folders to be sent to ChatGPT. Athena never falls back to DeepSeek or another account.</p>
  {#if error}<p class="problem" role="alert">{error}</p>{/if}
  {#if settings}
    <div class="connection-summary">
      <strong>{settings.account?.connected ? settings.account.planEnabled ? 'Signed in to ChatGPT' : 'Signed in — plan permission missing' : settings.account ? 'Disconnected · Registration saved' : 'Not connected'}</strong>
      {#if settings.account?.email}<span>{settings.account.email}</span>{/if}
      {#if settings.account?.reconnectRequired}<span>Reconnect required</span>{/if}
    </div>
    {#if !settings.protectedStorageAvailable}
      <p class="problem">Protected storage is unavailable. Unlock your login Keychain and check local storage; Athena will not store credentials as plaintext.</p>
    {/if}
    <p class="meta">Sign-in opens your system browser, saves credentials with macOS Keychain-backed encryption, and fetches available models when plan permission is granted. It sends no generation request. Nothing is refreshed automatically on launch.</p>
    <div class="actions">
      <button disabled={busy || active || !settings.protectedStorageAvailable} onclick={() => change(() => window.athena.chatgpt.connect())}>{settings.account ? 'Reconnect ChatGPT' : 'Continue with ChatGPT'}</button>
      {#if settings.account?.connected && !settings.account.planEnabled}
        <button disabled={busy || active || !settings.protectedStorageAvailable} onclick={() => change(() => window.athena.chatgpt.enablePlan())}>Enable ChatGPT plan use</button>
      {/if}
      {#if settings.account?.connected}
        <button disabled={busy || settings.activity === 'disconnect'} onclick={() => change(() => window.athena.chatgpt.disconnect())}>Disconnect ChatGPT</button>
      {/if}
      {#if active && settings.activity !== 'disconnect'}
        <button disabled={busy} onclick={() => change(() => window.athena.chatgpt.cancel())}>Cancel ChatGPT operation</button>
      {/if}
    </div>
    {#if settings.account && !settings.account.connected}
      <p class="meta">Reconnect reuses this registration. To connect a different account, forget it first; this does not delete the registration in ChatGPT.</p>
      <button disabled={busy || active} onclick={() => change(() => window.athena.chatgpt.forget())}>Forget disconnected registration</button>
    {/if}
    <div class="model-choice">
      <label for="chatgpt-model">ChatGPT model</label>
      <select id="chatgpt-model" value={settings.models.some(m => m.id === settings?.selectedModel) ? settings.selectedModel ?? '' : ''} disabled={busy || active || !settings.account?.planEnabled || !settings.models.length}
        onchange={event => { const id = event.currentTarget.value; if (id) void change(() => window.athena.chatgpt.selectModel(id)); }}>
        <option value="" disabled>Choose a discovered model</option>
        {#each settings.models as model}<option value={model.id}>{model.name}</option>{/each}
      </select>
      <button disabled={busy || active || !settings.account?.planEnabled || !settings.protectedStorageAvailable} onclick={() => change(() => window.athena.chatgpt.refreshModels())}>Refresh ChatGPT models</button>
    </div>
    {#if settings.selectedModel && !settings.models.some(m => m.id === settings?.selectedModel)}
      <p class="meta">Saved model: {settings.selectedModel}. Refresh models to check availability. Athena never chooses a replacement automatically.</p>
    {/if}
    <p class="meta">This selection applies to new conversations. Existing conversations retain their original model and registration. Send refreshes the catalog and expiring credentials as needed.</p>
    <h3>Test the selected model</h3>
    <blockquote>{CHATGPT_PROMPT}</blockquote>
    <p>One click sends only this prompt. Uses your ChatGPT plan or enabled credits. Cancellation may not prevent usage already incurred.</p>
    <p class="meta">20-second deadline · No output-token cap (unsupported by this route) · No tools, conversation history, automatic retries, or background work. The deadline is not a billing cap. DeepSeek's separate $1 gate does not measure this usage.</p>
    <div class="actions">
      <button class="primary" disabled={busy || active || !ready || !settings.protectedStorageAvailable} onclick={() => change(() => window.athena.chatgpt.test())}>Test ChatGPT connection</button>
      <button disabled={busy} onclick={() => change(() => window.athena.chatgpt.openUsage())}>Open ChatGPT usage settings</button>
    </div>
    <p aria-live="polite" class:problem={settings.test.status === 'failed'}>{settings.message}</p>
    {#if settings.test.usage}
      <p class="usage">Reported ChatGPT tokens: {settings.test.usage.input} input · {settings.test.usage.output} output · {settings.test.usage.cachedInput} cached input. No dollar-cost estimate.</p>
    {/if}
  {:else}<p>Loading ChatGPT settings…</p>{/if}
</section>

<style>
  .chatgpt { border-top: 1px solid var(--border); padding: 28px 0; }
  h2 { font-size: 20px; letter-spacing: -.4px; margin: 8px 0 12px; }
  h3 { font-size: 15px; margin: 24px 0 12px; }
  .connection-summary { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 14px 16px; background: var(--surface); border-left: 2px solid var(--accent); }
  .connection-summary span, .meta { color: var(--muted); overflow-wrap: anywhere; }
  .meta { font-size: 11px; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; }
  .model-choice { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 24px 0 12px; }
  .model-choice label { width: 100%; }
  select { max-width: 100%; min-width: 220px; padding: 9px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; }
  select:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  blockquote { margin: 12px 0; padding: 12px 16px; border-left: 2px solid var(--accent); background: var(--surface); font-family: 'SFMono-Regular', Consolas, monospace; }
  .usage { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; }
  .problem { color: var(--error-text); }
</style>
