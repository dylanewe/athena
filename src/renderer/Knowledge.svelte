<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { KnowledgeHit } from '../shared/knowledge';
  let { messageId = '', recordId = '', openConversation }: { messageId?: string; recordId?: string; openConversation: (id: string) => void } = $props();
  let records = $state<KnowledgeHit[]>([]);
  let error = $state('');
  let busy = $state(true);
  let onlyMessage = $state(true);
  let query = $state('');
  let scope = $state('');
  let exact = $state(false);
  let offset = $state(0);
  let nextOffset = $state<number>();
  let pages = $state<number[]>([]);
  let detailId = $state('');
  let excerpts = $state<Record<string, string>>({});
  let inspected = $state<Record<string, string>>({});
  async function load(next = 0) {
    busy = true; error = ''; excerpts = {}; inspected = {}; detailId = '';
    try {
      const result = await window.athena.knowledge.retrieve({ operation: 'search', query, ...(scope.trim() ? { scope: scope.trim() } : {}), exact, limit: 8, offset: next, ...(messageId && onlyMessage ? { messageId } : {}) });
      records = result.items; nextOffset = result.nextOffset; offset = next;
    } catch { records = []; error = 'Knowledge could not be loaded. Exact names need a repository scope. Check source permissions and retry.'; }
    finally { busy = false; }
  }
  function search() { pages = []; void load(); }
  async function showClaim(id: string) {
    busy = true; error = ''; onlyMessage = false; detailId = id; excerpts = {}; inspected = {};
    try {
      const result = await window.athena.knowledge.retrieve({ operation: 'detail', id });
      records = result.items; nextOffset = undefined; pages = []; offset = 0;
      if (!records.length) error = 'This claim is unavailable under current source permissions or retrieval bounds.';
      await tick(); document.getElementById(id)?.scrollIntoView({ block: 'center' });
    } catch { error = 'This claim could not be loaded. Retry search.'; }
    finally { busy = false; }
  }
  async function excerpt(record: KnowledgeHit, index: number) {
    const key = `${record.id}:${index}`;
    try {
      const result = await window.athena.knowledge.retrieve({ operation: 'evidence', id: record.id, index });
      const item = result.items[0];
      if (item) records = records.map(previous => previous.id === item.id ? { ...previous, validation: item.validation, freshness: item.freshness, validationNote: item.validationNote } : previous);
      const evidence = item?.evidence[0];
      excerpts[key] = evidence ? `${evidence.excerpt ?? ''}${evidence.truncated ? '\n[Bounded excerpt — inspect current file for more.]' : ''}` : 'Evidence unavailable under current source permissions.';
    } catch { excerpts[key] = 'Evidence could not be loaded. Retry search.'; }
  }
  async function inspect(record: KnowledgeHit, index: number) {
    const key = `${record.id}:${index}`;
    try {
      // Recheck access and freshness before navigating; never replay a revoked retained excerpt.
      const retained = await window.athena.knowledge.retrieve({ operation: 'evidence', id: record.id, index });
      const c = retained.currentCitation ?? retained.items[0]?.evidence[0]?.citation;
      if (!c) { inspected[key] = 'Current file is unavailable or withheld.'; return; }
      const result = await window.athena.sources.run('read', { root: c.folder, path: c.path, start: c.start, end: c.end });
      const entry = result.entries.find(entry => entry.citation);
      inspected[key] = entry ? `${entry.citation?.contentIdentity === c.contentIdentity ? 'Matches retained content.' : 'Changed — this is not the retained version.'}\n\n${entry.text}` : 'Current file is unavailable or withheld. A reconnected repository may have moved; inspect its new location in Sources.';
    } catch { inspected[key] = 'Current file unavailable. Finish other source browsing and retry.'; }
  }
  onMount(() => { if (recordId) void showClaim(recordId); else void load(); });
</script>

<main>
  <header><div><div class="eyebrow">Source-backed · On this Mac</div><h1>Knowledge</h1></div><button disabled={busy} onclick={() => detailId ? showClaim(detailId) : load(offset)}>Check freshness</button></header>
  <div class="knowledge-content">
    <p class="intro">Find concise architectural and domain findings. Static inspection is not runtime observation.</p>
    <form class="search" onsubmit={event => { event.preventDefault(); search(); }}>
      <label>Search knowledge<input aria-label="Search knowledge" bind:value={query} maxlength="200" placeholder="Topic, claim or evidence text" /></label>
      <label>Repository scope<input aria-label="Repository scope" bind:value={scope} placeholder="Registered name or alias" /></label>
      <label class="filter"><input type="checkbox" bind:checked={exact} /> Exact topic or alias</label>
      <button disabled={busy} type="submit">Search</button>
    </form>
    <p class="meta">Local text search, not semantic search. No match is not proof of absence. If results are insufficient, ask Athena to investigate fresh sources. Source permissions apply to every result; changed material is only an investigation lead. Implementation evidence takes precedence over declarations.</p>
    {#if messageId}<label class="filter"><input type="checkbox" bind:checked={onlyMessage} onchange={search} /> Only knowledge from this answer</label>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if busy}<p role="status">Checking bounded source dependencies…</p>{:else if !records.length}<p>No accessible indexed match in this page. This is not proof that a behavior or dependency does not exist. Try another name, another page, or a fresh investigation.</p>{/if}
    {#each records as record (record.id)}
      <article class:stale={record.validation === 'stale'} id={record.id}>
        <div class="topic"><div><div class="eyebrow">{record.scope} · {record.kind}</div><h2>{record.topic}</h2></div><span class="validation">{record.validation}</span></div>
        {#if record.aliases.length}<p class="meta">Aliases: {record.aliases.join(', ')}</p>{/if}
        <p>{record.summary}</p>
        <blockquote>{record.claim}</blockquote>
        <p class="meta">{record.provenance === 'declared' ? 'Declared in source' : 'Statically inferred'} · {record.perspective === 'current' ? 'Current-source interpretation' : record.perspective === 'intended' ? 'Intended behavior, not implementation' : 'Historical decision, not current behavior'} · Sources {record.freshness}</p>
        <p class="meta">{record.validationNote}</p>
        <button disabled={busy} onclick={() => showClaim(record.id)}>Knowledge details</button>
        {#if record.relations.length}<strong>Claim relationships</strong><ul>{#each record.relations as relation}<li>{relation.kind} · <a href={`#${relation.target}`} onclick={event => { event.preventDefault(); void showClaim(relation.target); }}>{relation.target}</a>{#each relation.owners ?? [] as owner}<button onclick={() => openConversation(owner.conversationId)}>Relationship source</button>{/each}</li>{/each}</ul>{/if}
        <details><summary>Evidence ({record.evidence.length})</summary>
          {#each record.evidence as evidence}
            <div class="citation"><strong>{evidence.citation.path}:{evidence.citation.start}–{evidence.citation.end}</strong>
              <p class="meta">{evidence.citation.repository?.name ?? 'Non-Git document'} · {evidence.citation.folder}<br />{evidence.citation.revision ?? 'Revision unavailable'} · {evidence.citation.contentIdentity}</p>
              <button onclick={() => excerpt(record, evidence.index)}>Read retained excerpt</button>
              {#if excerpts[`${record.id}:${evidence.index}`]}<pre>{excerpts[`${record.id}:${evidence.index}`]}</pre>{/if}
              <button onclick={() => inspect(record, evidence.index)}>Inspect current file</button>
              {#if inspected[`${record.id}:${evidence.index}`]}<pre>{inspected[`${record.id}:${evidence.index}`]}</pre>{/if}
            </div>
          {/each}
        </details>
        {#if record.detail}
          <details><summary>Inspected-file dependencies ({record.detail.dependencyCount})</summary><ul>{#each record.detail.dependencies as item}<li>{item.repository?.name ?? item.folder} · {item.path} · {item.contentIdentity}</li>{/each}</ul></details>
          {#if record.detail.scopeCount}<details><summary>Inspected search/list scopes ({record.detail.scopeCount})</summary><ul>{#each record.detail.scopes as item}<li>{item.operation} · {item.repository?.name ?? item.folder} · {item.path} · {item.query ?? ''} · {item.contentIdentity}</li>{/each}</ul></details>{/if}
        {/if}
        <details><summary>Originating answers ({record.owners.length})</summary>{#each record.owners as owner}<p><button onclick={() => openConversation(owner.conversationId)}>Open conversation</button> <span class="meta">{owner.messageId}</span></p>{/each}</details>
        {#if record.truncated}<p class="meta">Details are bounded; additional dependencies, owners or relationships were omitted.</p>{/if}
        <p class="identity">{record.id}</p>
      </article>
    {/each}
    <nav aria-label="Knowledge pages">
      <button disabled={busy || !pages.length} onclick={() => { const previous = pages.at(-1)!; pages = pages.slice(0, -1); void load(previous); }}>Previous page</button>
      <button disabled={busy || nextOffset === undefined} onclick={() => { pages = [...pages, offset]; void load(nextOffset); }}>Next page</button>
      <span class="meta">Page offset {offset} · up to 8 results</span>
    </nav>
  </div>
</main>

<style>
  .knowledge-content { padding: 20px 36px 36px; overflow-y: auto; min-height: 0; }
  .intro { max-width: 700px; font-size: 13px; line-height: 1.7; }
  .search { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
  .search label { font-size: 12px; flex: 1 1 180px; }
  .search input { display: block; margin-top: 6px; }
  .search .filter { flex: 0 1 auto; align-self: center; }
  .meta, .identity { color: var(--muted); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
  .identity, pre, li { font-family: 'SFMono-Regular', Consolas, monospace; }
  .filter { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .filter input { width: auto; }
  article { border-top: 1px solid var(--border); padding: 20px 0; margin-top: 20px; overflow-wrap: anywhere; }
  article.stale { border-left: 2px dashed var(--muted); padding-left: 16px; }
  .topic { display: flex; justify-content: space-between; align-items: start; gap: 16px; }
  h2 { font-size: 19px; font-weight: 500; margin: 6px 0; }
  .validation { font-size: 12px; border-bottom: 2px solid var(--accent); padding: 4px 0; }
  blockquote { border-left: 2px solid var(--accent); margin: 16px 0; padding-left: 14px; line-height: 1.7; }
  summary { cursor: pointer; padding: 8px 0; font-size: 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
  li { font-size: 11px; padding: 4px 0; }
  .citation { padding: 12px; background: var(--panel); }
  nav { display: flex; flex-direction: row; gap: 12px; align-items: center; margin-top: 20px; flex-wrap: wrap; }
</style>
