<script lang="ts">
  import { onMount } from 'svelte';
  import { CONNECTION_TYPES, isConnection, type KnowledgeHit, type KnowledgeRequest } from '../shared/knowledge';
  let { messageId = '', recordId = '', openKnowledge, ask, openFlows, returnToFlow }: { openFlows: (service: string) => void; returnToFlow?: () => void; messageId?: string; recordId?: string; openKnowledge: (id: string) => void; ask: (record: KnowledgeHit) => void } = $props();
  const visibleLimit = 200;
  type Batch = { items: KnowledgeHit[]; nextOffset?: number; omitted: boolean };
  let base = $state<Batch>({ items: [], omitted: false });
  let expansions = $state<Record<string, Batch>>({});
  const records = $derived([...new Map([...base.items, ...Object.values(expansions).flatMap(batch => batch.items)].map(record => [record.id, record])).values()].slice(0, visibleLimit));
  const omitted = $derived(base.omitted || Object.values(expansions).some(batch => batch.omitted) || records.length >= visibleLimit);
  let query = $state('');
  let provenance = $state<'' | 'declared' | 'statically-inferred'>('');
  let freshness = $state<'' | 'current' | 'stale'>('');
  let applied: Partial<Extract<KnowledgeRequest, { operation: 'neighborhood' }>> = {};
  let requestNumber = 0;
  let repositories = $state<string[]>([]);
  let scope = $state('');
  let depth = $state(1);
  let kind = $state('');
  let focus = $state('');
  let currentAnswer = $state(false);
  let reverse = $state(false);
  let busy = $state(false);
  let error = $state('');
  const entities = $derived(records.filter(record => record.architecture && !isConnection(record.architecture)));
  const groups = $derived([...new Set(entities.map(groupOf))].sort((a, b) => reverse ? b.localeCompare(a) : a.localeCompare(b)));
  const connections = $derived(records.filter(record => record.architecture && isConnection(record.architecture)));
  const outside = $derived(repositories.filter(name => !entities.some(record => record.scope === name && ['service', 'interface'].includes(record.architecture!.type))));
  function groupOf(record: KnowledgeHit) { return record.architecture && ['external', 'unresolved'].includes(record.architecture.type) ? 'External / unresolved' : record.scope; }
  function perspective(record: KnowledgeHit) { return record.perspective === 'current' ? 'Current-source interpretation' : record.perspective === 'intended' ? 'Intended — not implementation' : 'Historical — not current behavior'; }
  function apply() {
    applied = { ...(scope ? { scope } : {}), ...(currentAnswer && messageId ? { messageId } : {}), ...(query.trim() ? { query: query.trim() } : {}), ...(kind ? { kinds: [kind as typeof CONNECTION_TYPES[number]] } : {}), ...(provenance ? { provenance } : {}), ...(freshness ? { freshness } : {}) };
    void load('');
  }
  async function load(id = focus, mode: 'reset' | 'page' | 'expand' | 'focus' = 'reset') {
    const number = ++requestNumber;
    busy = true; error = '';
    const previous = mode === 'expand' ? expansions[id] : base;
    const offset = mode === 'page' || mode === 'expand' ? previous?.nextOffset ?? 0 : 0;
    if (mode === 'reset' || mode === 'focus') { base = { items: [], omitted: false }; expansions = {}; focus = id; }
    try {
      const result = await window.athena.knowledge.retrieve({ ...applied, operation: 'neighborhood', ...(id ? { id, scope: undefined, messageId: undefined, query: undefined } : {}), depth: mode === 'focus' ? 0 : mode === 'expand' ? 1 : depth, limit: 20, offset });
      if (number !== requestNumber) return;
      const batch = { items: [...new Map([...(mode === 'page' || mode === 'expand' ? previous?.items ?? [] : []), ...result.items].map(record => [record.id, record])).values()].slice(0, visibleLimit), nextOffset: result.nextOffset, omitted: (mode === 'page' || mode === 'expand' ? previous?.omitted : false) || (result.neighborhood?.omitted ?? true) };
      if (mode === 'expand') expansions = { ...expansions, [id]: batch };
      else base = batch;
    } catch {
      if (number !== requestNumber) return;
      // Do not leave earlier retained leads on screen after an authorization failure.
      base = { items: [], omitted: true }; expansions = {};
      error = 'The neighborhood could not be checked. Check source permissions and retry.';
    } finally { if (number === requestNumber) busy = false; }
  }
  function collapse(id: string) { const next = { ...expansions }; delete next[id]; expansions = next; }
  function label(id: string) { const record = entities.find(item => item.id === id); return record ? `${record.scope} / ${record.topic}` : 'Endpoint outside this bounded view'; }
  onMount(() => { focus = recordId; currentAnswer = !!messageId && !recordId; applied = currentAnswer ? { messageId } : {}; void window.athena.inventory.snapshot().then(snapshot => { repositories = snapshot.repositories.map(repo => repo.name); }).catch(() => {}); void load(); return () => { requestNumber++; }; });
</script>

<main>
  <header><div><div class="eyebrow">Evidence-backed · Read-only</div><h1>Services & dependencies</h1></div><button disabled={busy} onclick={() => load()}>Check map freshness</button></header>
  <div class="explorer-content">
    <button onclick={() => openFlows('')}>Flows in this investigation</button>
    <button onclick={() => openKnowledge('')}>Search all knowledge</button>
    <button disabled={busy} onclick={() => { focus = ''; apply(); }}>Reset map focus</button>
    {#if returnToFlow}<button onclick={returnToFlow}>Return to request flow</button>{/if}
    <p>Repository-scoped services, interfaces and concrete connections. Static analysis is not runtime observation. This is a bounded neighborhood, never a complete architecture or proof of isolation.</p>
    <form onsubmit={event => { event.preventDefault(); apply(); }}>
      <label>Map name or topic<input bind:value={query} maxlength="200" placeholder="Name, alias or topic" /></label>
      <label>Map provenance<select bind:value={provenance}><option value="">All provenance</option><option value="statically-inferred">Implementation / static inference</option><option value="declared">Declared in source</option></select></label>
      <label>Map freshness<select bind:value={freshness}><option value="">Current and stale leads</option><option value="current">Current sources (not verification)</option><option value="stale">Stale sources</option></select></label>
      <label>Map repository scope<select bind:value={scope}><option value="">Current neighborhood</option>{#each repositories as name}<option value={name}>{name}</option>{/each}</select></label>
      <label>Connection type<select bind:value={kind}><option value="">All concrete types</option>{#each CONNECTION_TYPES as type}<option value={type}>{type}</option>{/each}</select></label>
      <label>Traversal depth<select bind:value={depth}><option value={0}>0 · entities only</option><option value={1}>1 · direct neighbors</option><option value={2}>2 · two hops</option><option value={3}>3 · three hops</option></select></label>
      {#if messageId}<label class="check"><input type="checkbox" bind:checked={currentAnswer} /> Start from this investigation</label>{/if}
      <button disabled={busy}>Show neighborhood</button>
    </form>
    <p class="meta">Up to 200 visible claims, loaded in pages of 20 · Each page: 32 provenance claims · 256 source identities · 24 KiB · 10 seconds. Types describe explicit source evidence only; shared technologies and similar responsibilities create no edges.</p>
    <p class="coverage" role="status" aria-label="Map coverage">{entities.length} nodes · {connections.length} connections visible / 200 claims maximum.
      {#if omitted}Content omitted or not loaded under these bounds, filters or source permissions. Load another page, focus an entity or narrow the filters.{:else}This page is loaded. Other neighborhoods and relationships beyond the selected depth are not loaded.{/if}
      An absent connection is not proof of no relationship.
    </p>
    <button disabled={busy || base.nextOffset === undefined || records.length >= visibleLimit} onclick={() => load(focus, 'page')}>Load more map results</button>
    {#if records.length >= visibleLimit}<p>Focused-view limit reached. Collapse, focus or filter before loading more.</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if busy}<p role="status">Checking access and transitive source freshness…</p>{/if}
    {#if !busy && !entities.length}<p>No accessible service analysis in this neighborhood. Repositories may not yet be analyzed. Ask Athena to investigate named services and concrete dependencies; no routes need to be exhaustively enumerated.</p>{/if}
    <button onclick={() => reverse = !reverse}>Reverse visual group order</button>
    <p class="meta">Group order is display-only. It never edits claims or architectural meaning. Select any entity or connection to inspect its evidence.</p>
    <section class="map" aria-label="Dependency neighborhood">
      {#each groups as group}
        <section class="repository" aria-label={group}>
          <h2>{group}</h2>
          {#each entities.filter(record => groupOf(record) === group) as record (record.id)}
            <div class="entity" class:stale={record.freshness === 'stale'}>
              <span class="eyebrow">{record.architecture!.type}</span>
              <button class="node" onclick={() => openKnowledge(record.id)}>{record.topic}</button>
              <p class="meta">Sources {record.freshness} · {record.validation} · {record.provenance} · {perspective(record)}</p>
              {#if record.evidence[0]}<p class="location">{record.evidence[0].citation.path}:{record.evidence[0].citation.start}</p>{/if}
              <button disabled={busy} onclick={() => load(record.id, 'focus')}>Focus entity</button>
              <button disabled={busy || records.length >= visibleLimit || !!expansions[record.id] && expansions[record.id].nextOffset === undefined} onclick={() => load(record.id, 'expand')}>Expand neighbors</button>
              {#if expansions[record.id]}<button disabled={busy} onclick={() => collapse(record.id)}>Collapse neighbors</button>{/if}
              <button onclick={() => ask(record)}>Ask about entity</button>
              <button onclick={() => openFlows(record.id)}>Flows through this service</button>
            </div>
          {/each}
        </section>
      {/each}
    </section>
    <section aria-label="Concrete connections">
      <h2>Concrete connections</h2>
      {#each connections as record (record.id)}
        {@const a = record.architecture!}
        {#if isConnection(a)}
          <article class:stale={record.freshness === 'stale'}>
            <div class="connection"><span>{label(a.from)}</span><span aria-hidden="true">→</span><span>{label(a.to)}</span></div>
            <button class="edge" onclick={() => openKnowledge(record.id)}>{a.type} · {a.mechanism}</button>
            <p class="meta">Sources {record.freshness} · {record.validation} · {record.provenance} · {perspective(record)} · Not runtime-observed</p>
            <button onclick={() => ask(record)}>Ask about connection</button>
          </article>
        {/if}
      {/each}
      {#if !connections.length}<p class="meta">No concrete connections shown under these bounds and filters. This does not establish isolation or absence.</p>{/if}
    </section>
    {#if outside.length}<details><summary>Repositories outside this view ({outside.length})</summary>{#each outside as name}<p class="meta">{name} — Not analyzed here or outside the bounded neighborhood; not asserted isolated.</p>{/each}</details>{/if}
  </div>
</main>

<style>
  .explorer-content { padding: 20px 36px 36px; overflow-y: auto; min-height: 0; }
  p { font-size: 13px; line-height: 1.7; max-width: 850px; }
  form { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin: 20px 0; }
  label { font-size: 12px; } select { display: block; margin-top: 6px; max-width: 230px; }
  .check { display: flex; gap: 8px; align-items: center; } .check input { width: auto; }
  .coverage { border-left: 3px solid var(--accent); padding: 10px 14px; background: var(--panel); }
  .meta, .location { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
  .location { font-family: 'SFMono-Regular', Consolas, monospace; }
  .map { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 18px; margin: 24px 0; }
  .repository { border: 1px solid var(--border); border-top: 3px solid var(--accent); padding: 16px; min-width: 0; }
  h2 { font-size: 16px; font-weight: 500; overflow-wrap: anywhere; }
  .entity { border-top: 1px solid var(--border); padding: 14px 0; }
  .node { display: block; text-align: left; font-size: 18px; margin: 8px 0; overflow-wrap: anywhere; }
  .stale { border-left: 2px dashed var(--muted); padding-left: 10px; }
  article { border-top: 1px solid var(--border); padding: 16px 0; }
  .connection { display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; font-family: 'SFMono-Regular', Consolas, monospace; overflow-wrap: anywhere; }
  .edge { margin-top: 10px; text-align: left; overflow-wrap: anywhere; }
  summary { cursor: pointer; font-size: 12px; padding: 14px 0; }
</style>
