<script lang="ts">
  import { onMount } from 'svelte';
  import { RESET_CONFIRMATION, DELETE_CONVERSATION_CONFIRMATION, type MaintenanceStatus } from '../shared/maintenance';
  import type { ConversationSummary } from '../shared/contracts';
  let { active, conversations, selectedId, changed }: { active: boolean; conversations: ConversationSummary[]; selectedId?: string; changed: () => void } = $props();
  let status = $state<MaintenanceStatus>();
  let days = $state(30);
  let forever = $state(false);
  let resetConfirmed = $state(false);
  let deleteConfirmed = $state(false);
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  const selected = $derived(conversations.find(item => item.id === selectedId));
  $effect(() => { selectedId; deleteConfirmed = false; });
  async function load() {
    try {
      status = await window.athena.maintenance.snapshot();
      days = status.retention.verboseDays ?? 30; forever = status.retention.verboseDays === null;
    } catch { error = 'Local data status unavailable. Reload status to retry.'; }
  }
  async function act(action: () => Promise<MaintenanceStatus>, success: string) {
    busy = true; error = ''; notice = '';
    try { status = await action(); notice = success; resetConfirmed = false; deleteConfirmed = false; changed(); }
    catch (failure) { error = failure instanceof Error ? failure.message : 'Local maintenance failed. Reload status and retry cleanup.'; await load(); }
    finally { busy = false; }
  }
  onMount(() => { void load(); });
</script>

<main class="local-data">
  <header><span class="eyebrow">On this Mac</span><h1>Local data</h1><p>Retention and cleanup stay on this Mac. No analytics, uploads, or model calls.</p></header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if active}<p>Finish active work or save pending results before changing local data.</p>{/if}
  {#if status}
    <section aria-label="History retention">
      <h2>History retention</h2>
      <dl>
        <div><dt>Conversations & concise investigation records</dt><dd>Until explicitly deleted</dd></div>
        <div><dt>Answer citations & evidence</dt><dd>Kept with retained answers, separate from verbose transcripts</dd></div>
        <div><dt>Verbose child & tool transcripts</dt><dd>{status.retention.verboseDays === null ? 'Keep forever' : `${status.retention.verboseDays} days after each attempt ends`}</dd></div>
      </dl>
      <p>Actual approved environment-file contents and derived output remain non-durable. Revoked data stays excluded from model context; folder purge still removes its associated data.</p>
      <form onsubmit={event => { event.preventDefault(); void act(() => window.athena.maintenance.policy(forever ? null : days), 'Retention policy saved. Cleanup applies it locally; expired transcripts cannot be restored.'); }}>
        <label><input type="checkbox" bind:checked={forever} disabled={busy || active} /> Keep verbose transcripts forever</label>
        <label>Verbose transcript retention (days)<input type="number" min="0" max="3650" step="1" bind:value={days} disabled={busy || active || forever} /></label>
        <p>Default: 30 days. Zero expires completed attempts on the next cleanup. Saving a policy does not restore expired history. Cleanup runs at launch and hourly when idle, or explicitly below.</p>
        <button disabled={busy || active || !forever && (!Number.isInteger(days) || days < 0 || days > 3650)}>Save retention policy</button>
      </form>
      <p>{status.retention.expiredAttempts} attempts with expired transcripts · {status.retention.eligibleAttempts} eligible for cleanup</p>
      <p>History cleanup: {status.retention.cleanupPending ? 'Pending checkpoint — retry cleanup' : 'Up to date'}{status.retention.lastDeletionAt ? ` · Last deletion ${status.retention.lastDeletionAt}` : ''}</p>
      <p>Knowledge cleanup: {status.knowledge.cleanupPending ? 'Pending checkpoint — retry cleanup' : 'Up to date'}{status.knowledge.lastDeletionAt ? ` · Last reset ${status.knowledge.lastDeletionAt}` : ''}</p>
      <div class="actions"><button disabled={busy || active} onclick={() => act(() => window.athena.maintenance.cleanup(), 'Local cleanup complete. Retained answers and citations are unchanged.')}>Run local cleanup</button><button disabled={busy} onclick={() => { error = ''; void load(); }}>Reload data status</button></div>
    </section>
    <section aria-label="Reset knowledge cache">
      <h2>Reset knowledge cache</h2>
      <p>Clear derived claims, search indexes, maps, flows and build reuse. Keep conversations, settings, folder/provider permissions, repository aliases and durable user resolutions.</p>
      <p>Rebuilding may require paid reinvestigation. Reset does not start model calls or automatically recreate knowledge from saved answers. Use Repositories → Build/refresh knowledge afterward, with explicit paid consent, current permissions and the existing job limits.</p>
      <p>Annotations never silently reattach, even if extracted IDs repeat. Open Knowledge → Show all retained annotations to reconcile unmatched or changed claim/evidence versions explicitly.</p>
      <label><input type="checkbox" bind:checked={resetConfirmed} disabled={busy || active} /> I understand that reset clears derived knowledge, not my saved answers or annotations</label>
      <button disabled={busy || active || !resetConfirmed} onclick={() => act(() => window.athena.maintenance.reset(RESET_CONFIRMATION), 'Knowledge cache reset. No model work started. Rebuild explicitly from Repositories when ready.')}>Reset knowledge cache</button>
    </section>
    <section aria-label="Delete saved conversation">
      <h2>Delete saved conversation</h2>
      {#if selected}
        <p>Selected: <strong>{selected.title}</strong>. Permanently delete its messages, investigation records, transcripts and answer evidence. Knowledge and user annotations have independent lifetimes and are not deleted here. Use folder purge to remove all source-associated data.</p>
        <label><input type="checkbox" bind:checked={deleteConfirmed} disabled={busy || active} /> Permanently delete this conversation and its answer evidence</label>
        <button disabled={busy || active || !deleteConfirmed} onclick={() => act(() => window.athena.maintenance.deleteConversation(selected.id, DELETE_CONVERSATION_CONFIRMATION), 'Conversation deleted locally. It will not be recreated automatically.')}>Delete selected conversation</button>
      {:else}<p>Select a saved conversation in the sidebar to delete it.</p>{/if}
    </section>
  {/if}
</main>

<style>
  .local-data { display: block; overflow-y: auto; padding: 36px; max-width: 960px; width: 100%; }
  header { margin-bottom: 28px; }
  h1 { font-size: 26px; font-weight: 500; }
  h2 { font-size: 18px; font-weight: 500; }
  section { border-top: 1px solid var(--border); margin-top: 28px; padding-top: 22px; }
  p, label, dl { font-size: 13px; line-height: 1.7; }
  p { color: var(--muted); }
  dl { margin: 18px 0; }
  dl div { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border); }
  dt { color: var(--muted); } dd { margin: 0; }
  label { display: block; margin: 14px 0; }
  input[type=checkbox] { width: auto; }
  input[type=number] { display: block; width: 140px; margin-top: 6px; }
  .actions { display: flex; gap: 12px; flex-wrap: wrap; }
  @media (max-width: 760px) { .local-data { padding: 24px; } dl div { grid-template-columns: 1fr; gap: 4px; } }
</style>
