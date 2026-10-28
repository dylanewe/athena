<script lang="ts">
  import { onMount } from 'svelte';
  import { FOLDER_CONSENT, type InventoryWorkspace } from '../shared/inventory';

  let inventory = $state<InventoryWorkspace | null>(null);
  let error = $state('');
  let busy = $state(false);
  let accepted = $state(false);
  let includes = $state<Record<string, string>>({});
  let aliases = $state<Record<string, string>>({});
  let connections = $state<Record<string, string>>({});
  let documentation = $state<Record<string, string>>({});
  let requestNumber = 0;
  const scanning = $derived(inventory?.discovery.status === 'running');
  const missing = $derived(inventory?.repositories.filter(repo => repo.presence === 'missing') ?? []);

  async function load() {
    const number = ++requestNumber;
    try {
      const next = await window.athena.inventory.snapshot();
      if (number === requestNumber) inventory = next;
    } catch { error = 'Could not load repository inventory. Restart Athena to retry.'; }
  }
  async function change(action: () => Promise<InventoryWorkspace>) {
    busy = true;
    error = '';
    const number = ++requestNumber;
    try {
      const next = await action();
      if (number === requestNumber) inventory = next;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not save inventory. Try again.';
    } finally { busy = false; }
  }
  async function consent() {
    const path = inventory?.pendingFolder;
    if (!path || !accepted) return;
    await change(async () => {
      await window.athena.inventory.consentFolder(path, FOLDER_CONSENT);
      return window.athena.inventory.scan();
    });
    accepted = false;
  }
  onMount(() => {
    const unsubscribe = window.athena.onChange(() => { void load(); });
    void load();
    return unsubscribe;
  });
</script>

<main>
  <header>
    <div><div class="eyebrow">Knowledge on this Mac</div><h1>Repositories</h1></div>
    <button class="primary" disabled={busy || scanning || !inventory} onclick={() => { accepted = false; void change(() => window.athena.inventory.chooseFolder()); }}>Choose folder</button>
  </header>
  <div class="inventory-content">
    <p class="intro">Designate a folder, then organize what Athena finds. Discovery is local only: no model calls, uploads, or charges. Every repository remains unexamined.</p>
    {#if error}<div class="inventory-error" role="alert">{error}</div>{/if}
    {#if inventory?.pendingFolder}
      <section class="consent" aria-label="Folder permission">
        <span class="eyebrow">Before discovery</span>
        <h2>One folder. An explicit permission.</h2>
        <p class="path">{inventory.pendingFolder}</p>
        <p>{FOLDER_CONSENT}</p>
        <label class="check"><input type="checkbox" bind:checked={accepted} /> I understand the folder permission</label>
        <div class="actions">
          <button class="primary" disabled={!accepted || busy} onclick={consent}>Save consent and discover</button>
          <button disabled={busy} onclick={() => change(() => window.athena.inventory.dismissFolder())}>Cancel folder selection</button>
        </div>
      </section>
    {/if}
    {#if inventory}
      <section class="discovery" aria-label="Discovery">
        <div class="actions">
          <strong role="status" aria-live="polite">{scanning ? 'Discovering locally…' : inventory.discovery.status === 'complete' ? 'Discovery complete' : inventory.discovery.status === 'cancelled' ? 'Discovery cancelled — results are partial' : inventory.discovery.status === 'failed' ? 'Discovery failed — rescan to retry' : 'Ready to discover'}</strong>
          {#if scanning}
            <button disabled={busy} onclick={() => change(() => window.athena.inventory.cancel())}>Cancel discovery</button>
          {:else}
            <button disabled={busy || !inventory.roots.length} onclick={() => change(() => window.athena.inventory.scan())}>Rescan folders</button>
          {/if}
        </div>
        <p class="meta">{inventory.discovery.visited} directories visited · {inventory.discovery.nonGitFiles} non-Git files · {inventory.repositories.length} registered repositories</p>
        {#if scanning}<p class="path current">{inventory.discovery.current}</p>{/if}
        {#if inventory.discovery.failures.length}
          <div class="inventory-error" role="alert">
            <strong>Some locations could not be inspected. Results may be incomplete.</strong>
            <ul>{#each inventory.discovery.failures as failure}<li><span class="path">{failure.path}</span><br />{failure.message}</li>{/each}</ul>
          </div>
        {/if}
      </section>
      <section aria-label="Designated folders">
        <h2 class="section-title">Designated folders</h2>
        {#if !inventory.roots.length}<p class="meta">Choose a folder to review its permission. Nothing is accessed until you save consent.</p>{/if}
        {#each inventory.roots as root (root.path)}
          <article class="root">
            <p class="path">{root.path}</p>
            <p class="meta">Consent saved {new Date(root.acceptedAt).toLocaleDateString()}. Includes future repositories and non-Git material.</p>
            <details><summary>Saved permission</summary><p>{root.consent}</p></details>
            <p class="meta">Hidden directories, dependencies, vendor directories, and build outputs are skipped by default. Directory symlinks are never followed. Git metadata cannot be included.</p>
            {#if root.includedLocations.length}<p class="meta">Explicitly included: {root.includedLocations.join(', ')}</p>{/if}
            <form onsubmit={(event) => {
              event.preventDefault();
              void change(async () => {
                await window.athena.inventory.include(root.path, includes[root.path] ?? '');
                includes[root.path] = '';
                return window.athena.inventory.scan();
              });
            }}>
              <label for={`include-${root.path}`}>Include a skipped location within {root.path}</label>
              <div class="inline-form"><input id={`include-${root.path}`} bind:value={includes[root.path]} placeholder="e.g. .archive/service" maxlength="4096" /><button disabled={busy || scanning || !includes[root.path]}>Include and rescan</button></div>
            </form>
          </article>
        {/each}
      </section>
      {#if inventory.candidates.length}
        <section aria-label="Repositories needing a decision">
          <h2 class="section-title">Choose an identity</h2>
          <p class="meta">Names are unique and stay independent of location. Nothing is merged automatically.</p>
          {#each inventory.candidates as candidate (candidate.path)}
            <article class="repository">
              <h3>{candidate.name}</h3><p class="path">{candidate.path}</p>
              <p>{candidate.reason === 'collision' ? 'This name is already in use or needs a valid alias. Choose a unique alias.' : 'A registered repository is missing. Register this as new, or explicitly reconnect it below.'}</p>
              {#if candidate.presence === 'unknown'}<p class="meta">Location not checked. Rescan before making a decision.</p>{/if}
              <form onsubmit={(event) => { event.preventDefault(); void change(() => window.athena.inventory.register(candidate.path, aliases[candidate.path] ?? candidate.name)); }}>
                <label for={`alias-${candidate.path}`}>Repository name for {candidate.path}</label>
                <div class="inline-form"><input id={`alias-${candidate.path}`} value={aliases[candidate.path] ?? candidate.name} oninput={event => aliases[candidate.path] = event.currentTarget.value} maxlength="100" /><button disabled={busy || scanning || candidate.presence !== 'present'}>Register repository</button></div>
              </form>
              {#if missing.length}
                <form class="reconnect" onsubmit={(event) => { event.preventDefault(); void change(() => window.athena.inventory.reconnect(connections[candidate.path], candidate.path)); }}>
                  <label for={`reconnect-${candidate.path}`}>Reconnect a missing repository to {candidate.path}</label>
                  <select id={`reconnect-${candidate.path}`} bind:value={connections[candidate.path]}>
                    <option value="">Choose the original name</option>
                    {#each missing as repository}<option value={repository.name}>{repository.name} — {repository.path}</option>{/each}
                  </select>
                  <button disabled={busy || scanning || !connections[candidate.path] || candidate.presence !== 'present'}>Confirm reconnection</button>
                  <p class="meta">Keeps the original name and documentation hints; replaces only its location.</p>
                </form>
              {/if}
            </article>
          {/each}
        </section>
      {/if}
      <section aria-label="Registered repositories">
        <h2 class="section-title">Repository inventory</h2>
        {#if inventory.roots.length && !inventory.repositories.length}<p class="meta">No registered repositories yet. Non-Git material is still eligible within your designated folders.</p>{/if}
        {#each inventory.repositories as repository (repository.name)}
          <article class="repository">
            <div class="repository-heading"><h3>{repository.name}</h3><span class="demo-badge">Unexamined</span></div>
            <p class="path">{repository.path}</p>
            <p class="meta">{repository.presence === 'missing' ? 'Missing — rescan its new location, then explicitly reconnect above.' : repository.presence === 'unknown' ? 'Location not checked — rescan to verify.' : `${repository.fileCount} discovered files · ${repository.boundaries.length} nested repository boundaries`}</p>
            {#if repository.boundaries.length}<p class="meta">Separate contents: {repository.boundaries.join(', ')}</p>{/if}
            <form onsubmit={(event) => {
              event.preventDefault();
              const value = documentation[repository.name] ?? repository.documentationRoots.join('\n');
              void change(() => window.athena.inventory.documentation(repository.name, value.split('\n').filter(line => line.length > 0)));
            }}>
              <label for={`docs-${repository.name}`}>Documentation starting directories for {repository.name}</label>
              <textarea id={`docs-${repository.name}`} rows="2" value={documentation[repository.name] ?? repository.documentationRoots.join('\n')} oninput={event => documentation[repository.name] = event.currentTarget.value}></textarea>
              <div class="actions"><p class="meta">One relative directory per line. Prioritization hints, not limits on eligible content.</p><button aria-label={`Save documentation hints for ${repository.name}`} disabled={busy || scanning || repository.presence !== 'present'}>Save hints</button></div>
            </form>
          </article>
        {/each}
      </section>
    {/if}
  </div>
</main>

<style>
  .inventory-content { padding: 20px 36px 36px; overflow-y: auto; min-height: 0; }
  .intro, p, details { font-size: 13px; line-height: 1.7; }
  .intro { color: var(--muted); max-width: 660px; margin: 0 0 24px; }
  .path { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 11px; overflow-wrap: anywhere; color: var(--accent); }
  .meta { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
  .consent { border-left: 3px solid var(--accent); background: var(--accent-surface); padding: 22px; margin-bottom: 24px; }
  .consent h2 { font-size: 26px; letter-spacing: -.7px; margin: 12px 0; }
  .check { display: flex; align-items: center; gap: 10px; margin: 20px 0; color: var(--text); }
  .check input { width: auto; accent-color: var(--accent); }
  .actions, .inline-form, .repository-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .actions { flex-wrap: wrap; }
  .actions button, .inline-form button { flex-shrink: 0; }
  .actions .meta { flex: 1; min-width: 160px; }
  .discovery { padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  .discovery strong { font-size: 13px; }
  .current { max-height: 48px; overflow-y: auto; }
  .section-title { font-size: 17px; letter-spacing: -.3px; margin: 28px 0 12px; }
  .root, .repository { border-top: 1px solid var(--border); padding: 18px 0; }
  h3 { font-size: 16px; margin: 0; overflow-wrap: anywhere; }
  form { margin-top: 14px; }
  textarea { font-size: 12px; resize: vertical; }
  select { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 9px; max-width: 100%; margin: 0 8px 10px 0; }
  select:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .inventory-error { background: var(--error-surface); color: var(--error-text); padding: 12px; margin-bottom: 16px; font-size: 13px; }
  summary { cursor: pointer; font-size: 11px; color: var(--muted); }
  li { margin: 10px 0; }
  @media (max-width: 800px) { .inventory-content { padding: 20px 22px; } .inline-form { flex-wrap: wrap; } }
</style>
