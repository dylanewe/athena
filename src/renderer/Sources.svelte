<script lang="ts">
  import { onMount } from 'svelte';
  import { SOURCE_WARNING, type SourceException, type SourceOperation, type SourceResult } from '../shared/sources';
  let roots = $state<string[]>([]);
  let root = $state('');
  let path = $state('.');
  let query = $state('');
  let start = $state(1);
  let end = $state(40);
  let result = $state<SourceResult | null>(null);
  let exceptions = $state<SourceException[]>([]);
  let exceptionPath = $state('');
  let error = $state('');
  let busy = $state(false);
  onMount(() => {
    void Promise.all([window.athena.inventory.snapshot(), window.athena.sources.exceptions()]).then(([inventory, saved]) => {
      roots = inventory.roots.map(item => item.path);
      root = roots[0] ?? '';
      exceptions = saved;
    }).catch(() => error = 'Could not load folders. Open Repositories to check folder permission.');
    return () => { void window.athena.sources.cancel(); };
  });
  async function run(operation: SourceOperation, selected = path) {
    busy = true; error = ''; result = null; path = selected;
    try {
      result = await window.athena.sources.run(operation, {
        root, path: selected,
        ...(operation === 'search' ? { query } : {}),
        ...(operation === 'read' ? { start, end } : {}),
      });
    } catch (failure) { error = failure instanceof Error ? failure.message : 'Browsing failed. Check the path and retry.'; }
    finally { busy = false; }
  }
  async function exception(value: string, include: boolean) {
    try { exceptions = await window.athena.sources.exception(root, value, include); exceptionPath = ''; }
    catch { error = 'Cannot include this path. Check that it exists inside this folder and is not protected or a symlink.'; }
  }
</script>

<main>
  <header><div><div class="eyebrow">Current files · Local only</div><h1>Sources</h1></div><span class="demo-badge">Read-only</span></header>
  <div class="source-content">
    <p class="intro">{SOURCE_WARNING}</p>
    <p class="meta">UTF-8 code, Markdown, plain text, JSON, YAML, and other structured text. No PDF, images, execution, remote fetching, or historical revisions.</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if !roots.length}<p>Choose and approve a folder in Repositories before browsing.</p>{:else}
      <form onsubmit={event => { event.preventDefault(); void run('search'); }}>
        <label for="source-root">Designated folder</label>
        <select id="source-root" bind:value={root} disabled={busy} onchange={() => { path = '.'; result = null; }}>{#each roots as value}<option value={value}>{value}</option>{/each}</select>
        <label for="source-path">Relative file or directory</label>
        <input id="source-path" bind:value={path} maxlength="4096" disabled={busy} />
        <div class="range">
          <label>First line<input aria-label="First line" type="number" min="1" max="1000000" bind:value={start} disabled={busy} /></label>
          <label>Last line<input aria-label="Last line" type="number" min="1" max="1000000" bind:value={end} disabled={busy} /></label>
          <button type="button" disabled={busy} onclick={() => run('read')}>Read range</button>
          <button type="button" disabled={busy} onclick={() => run('list')}>List files</button>
        </div>
        <label for="source-query">Find text (literal, case-insensitive)</label>
        <div class="search"><input id="source-query" bind:value={query} maxlength="200" disabled={busy} /><button class="primary" disabled={busy || !query.trim()}>Search sources</button></div>
      </form>
      {#if busy}<p role="status">Browsing locally… <button onclick={() => window.athena.sources.cancel()}>Cancel browsing</button></p>{/if}
      {#if result}
        <p role="status">{result.status === 'complete' ? 'Browsing complete' : result.status === 'cancelled' ? 'Browsing cancelled — partial results' : 'Results truncated'} · {result.scanned} entries checked · {result.bytesRead} bytes read{result.reason ? ` · ${result.reason}` : ''}</p>
        {#if !result.entries.length}<p class="meta">No eligible matches in the checked files. Try another path or search.</p>{/if}
        <div class="ledger" aria-label="Source results">
          {#each result.entries as entry, index (`${entry.path}-${index}`)}
            <article>
              <div class="entry-heading"><strong class="path">{entry.path}</strong>
                {#if !entry.reason && !entry.citation}<button disabled={busy} onclick={() => run(entry.kind === 'directory' ? 'list' : 'read', entry.path)}>{entry.kind === 'directory' ? 'Browse' : 'Read'}</button>{/if}
              </div>
              {#if entry.reason}<p class="meta">{entry.reason}</p>{/if}
              {#if entry.overridable}<button disabled={busy} onclick={() => exception(entry.path, true)}>Include this exclusion</button>{/if}
              {#if entry.citation}
                <p class="citation">{entry.citation.repository?.name ?? 'Non-Git document'} · lines {entry.citation.start}–{entry.citation.end}<br />Folder: {entry.citation.folder}<br />Repository: {entry.citation.repository?.path ?? 'none'}<br />Checkout: {entry.citation.revision ?? 'unavailable (non-Git, unborn, or external worktree metadata)'}<br />{entry.citation.contentIdentity}</p>
                <pre>{entry.text}</pre>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
      <details>
        <summary>Exclusions and saved exceptions</summary>
        <p class="meta">Hidden, ignored, vendor, and generated material is excluded by default. Include a relative file or subtree to override those defaults. Git internals, symlinks, confinement, credential files, binary/encoding limits, and suspected secrets cannot be overridden. Exceptions do not change repository discovery. Excluded directories are not searched for individual matches.</p>
        <form onsubmit={event => { event.preventDefault(); void exception(exceptionPath, true); }}>
          <label for="source-exception">Include an excluded relative path</label>
          <div class="search"><input id="source-exception" bind:value={exceptionPath} maxlength="4096" /><button disabled={busy || !exceptionPath}>Save exception</button></div>
        </form>
        {#each exceptions.filter(item => item.root === root) as item}<p class="path">{item.path} <button disabled={busy} onclick={() => exception(item.path, false)}>Remove exception</button></p>{/each}
      </details>
      <p class="meta">Each operation: 5 seconds, 2,000 checked entries, 200 results, 2 MiB input, 64 KiB output. Files over 256 KiB are withheld; range reads cover at most 200 lines. Limits and unsupported inputs are reported, never silently treated as complete coverage.</p>
    {/if}
  </div>
</main>

<style>
  .source-content { padding: 20px 36px 36px; overflow-y: auto; min-height: 0; }
  .intro { max-width: 700px; font-size: 13px; line-height: 1.7; }
  .meta, .citation { color: var(--muted); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
  .path, .citation, pre { font-family: 'SFMono-Regular', Consolas, monospace; }
  .path { font-size: 12px; overflow-wrap: anywhere; }
  .citation { border-left: 2px solid var(--accent); padding-left: 12px; }
  select { width: 100%; background: var(--surface); color: var(--text); border: 1px solid var(--border); padding: 10px; margin-bottom: 16px; }
  .range, .search, .entry-heading { display: flex; align-items: end; gap: 12px; margin: 12px 0; }
  .range label { max-width: 110px; }
  .range input { margin-bottom: 0; }
  .search input { flex: 1; min-width: 0; }
  .entry-heading { align-items: center; justify-content: space-between; }
  button { flex-shrink: 0; }
  article { border-top: 1px solid var(--border); padding: 10px 0 20px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface); font-size: 12px; line-height: 1.6; padding: 14px; margin: 0; }
  details { margin-top: 30px; border-top: 1px solid var(--border); padding-top: 16px; }
  summary { cursor: pointer; font-size: 13px; }
  @media (max-width: 800px) { .source-content { padding: 20px 22px; } .range { flex-wrap: wrap; } }
</style>
