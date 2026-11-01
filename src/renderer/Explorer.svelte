<script lang="ts">
  import { onMount } from 'svelte';
  import { CONNECTION_TYPES, isConnection, type KnowledgeHit } from '../shared/knowledge';
  let { messageId = '', recordId = '', openKnowledge, ask }: { messageId?: string; recordId?: string; openKnowledge: (id: string) => void; ask: (record: KnowledgeHit) => void } = $props();
  let records = $state<KnowledgeHit[]>([]);
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
  const groups = $derived([...new Set(entities.map(record => ['external', 'unresolved'].includes(record.architecture!.type) ? 'External / unresolved' : record.scope))].sort((a, b) => reverse ? b.localeCompare(a) : a.localeCompare(b)));
  const connections = $derived(records.filter(record => record.architecture && isConnection(record.architecture)));
  const outside = $derived(repositories.filter(name => !entities.some(record => record.scope === name && ['service', 'interface'].includes(record.architecture!.type))));
  async function load(id = focus) {
    busy = true; error = '';
    try {
      const result = await window.athena.knowledge.retrieve({ operation: 'neighborhood', ...(id ? { id } : {}), ...(scope && !id ? { scope } : {}), ...(currentAnswer && !id ? { messageId } : {}), depth, limit: 20, ...(kind ? { kinds: [kind as typeof CONNECTION_TYPES[number]] } : {}) });
      records = result.items; focus = id;
    } catch { records = []; error = 'The neighborhood could not be checked. Check source permissions and retry.'; }
    finally { busy = false; }
  }
  function label(id: string) { const record = entities.find(item => item.id === id); return record ? `${record.scope} / ${record.topic}` : 'Endpoint outside this bounded view'; }
  onMount(() => { focus = recordId; currentAnswer = !!messageId && !recordId; void window.athena.inventory.snapshot().then(snapshot => { repositories = snapshot.repositories.map(repo => repo.name); }).catch(() => {}); void load(); });
</script>

<main>
  <header><div><div class="eyebrow">Evidence-backed · Read-only</div><h1>Services & dependencies</h1></div><button disabled={busy} onclick={() => load()}>Check map freshness</button></header>
  <div class="explorer-content">
    <p>Repository-scoped services, interfaces and concrete connections. Static analysis is not runtime observation. This is a bounded neighborhood, never a complete architecture or proof of isolation.</p>
    <form onsubmit={event => { event.preventDefault(); focus = ''; void load(''); }}>
      <label>Map repository scope<select bind:value={scope}><option value="">Current neighborhood</option>{#each repositories as name}<option value={name}>{name}</option>{/each}</select></label>
      <label>Connection type<select bind:value={kind}><option value="">All concrete types</option>{#each CONNECTION_TYPES as type}<option value={type}>{type}</option>{/each}</select></label>
      <label>Traversal depth<select bind:value={depth}><option value={0}>0 · entities only</option><option value={1}>1 · direct neighbors</option><option value={2}>2 · two hops</option><option value={3}>3 · three hops</option></select></label>
      {#if messageId}<label class="check"><input type="checkbox" bind:checked={currentAnswer} /> Start from this investigation</label>{/if}
      <button disabled={busy}>Show neighborhood</button>
    </form>
    <p class="meta">Up to 20 claims · 32 provenance claims · 256 source identities · 24 KiB · 10 seconds. Types describe explicit source evidence only; shared technologies and similar responsibilities create no edges.</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if busy}<p role="status">Checking access and transitive source freshness…</p>{/if}
    {#if !busy && !entities.length}<p>No accessible service analysis in this neighborhood. Repositories may not yet be analyzed. Ask Athena to investigate named services and concrete dependencies; no routes need to be exhaustively enumerated.</p>{/if}
    <button onclick={() => reverse = !reverse}>Reverse visual group order</button>
    <p class="meta">Group order is display-only. It never edits claims or architectural meaning. Select any entity or connection to inspect its evidence.</p>
    <section class="map" aria-label="Dependency neighborhood">
      {#each groups as group}
        <section class="repository" aria-label={group}>
          <h2>{group}</h2>
          {#each entities.filter(record => (['external', 'unresolved'].includes(record.architecture!.type) ? 'External / unresolved' : record.scope) === group) as record (record.id)}
            <div class="entity" class:stale={record.freshness === 'stale'}>
              <span class="eyebrow">{record.architecture!.type}</span>
              <button class="node" onclick={() => openKnowledge(record.id)}>{record.topic}</button>
              <p class="meta">Sources {record.freshness} · {record.validation} · {record.provenance}</p>
              {#if record.evidence[0]}<p class="location">{record.evidence[0].citation.path}:{record.evidence[0].citation.start}</p>{/if}
              <button disabled={busy} onclick={() => { currentAnswer = false; void load(record.id); }}>Expand neighbors</button>
              <button onclick={() => ask(record)}>Ask about entity</button>
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
            <p class="meta">Sources {record.freshness} · {record.validation} · {record.provenance} · Not runtime-observed</p>
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
