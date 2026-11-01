<script lang="ts">
  import { onMount } from 'svelte';
  import { flowHandoffs, type KnowledgeHit, type OperationFlow } from '../shared/knowledge';
  let { messageId = '', serviceId = '', recordId = '', openKnowledge, openExplorer, openConversation, remember }: {
    messageId?: string; serviceId?: string; recordId?: string;
    openKnowledge: (id: string) => void; openExplorer: (id: string) => void;
    openConversation: (id: string) => void; remember: (id: string) => void;
  } = $props();
  let records = $state<KnowledgeHit[]>([]);
  let selectedId = $state('');
  let busy = $state(false);
  let error = $state('');
  let nextOffset = $state<number>();
  let offset = $state(0);
  let focused = $state<number>();
  let collapsed = $state<number[]>([]);
  const selected = $derived(records.find(record => record.id === selectedId));
  const edges = $derived(selected?.flow ? flowHandoffs(selected.flow) : []);
  const expanded = $derived(!!selected?.flow && (selected.flow.handoffs.some(edge => edge.from !== undefined) || selected.flow.steps.some(step => step.kind)));
  const hiddenSteps = $derived(focused === undefined ? 0 : (selected?.flow?.steps.length ?? 1) - 1);
  const hiddenEdges = $derived(edges.filter(edge => (focused !== undefined && edge.from !== focused) || collapsed.includes(edge.from)).length);
  const handoffLabels = { synchronous: 'Synchronous handoff →', asynchronous: 'Asynchronous event/message →', unknown: 'Unknown handoff / gap →', 'within-service': 'Within-service step →' };
  const stepLabels = { branch: 'Conditional branch', parallel: 'Parallel dispatch', join: 'Convergence / join', retry: 'Retry (annotated)', loop: 'Loop (annotated)' };
  function kindLabel(step: OperationFlow['steps'][number]) {
    return step.kind ? `${step.state === 'unknown' ? 'Unresolved: ' : ''}${stepLabels[step.kind]}` : '';
  }
  function support(id: string) { return records.find(record => record.id === id); }
  function status(id: string) {
    const record = support(id);
    return record ? `Sources ${record.freshness} · ${record.provenance === 'declared' ? 'Documented' : 'Statically supported interpretation'} · ${record.perspective} · ${record.validation}${record.validation === 'unchecked' || record.validation === 'conflicting' ? ' · Uncertain interpretation' : ''}` : 'Support unavailable';
  }
  function showAll() { focused = undefined; collapsed = []; }
  async function load(id = selectedId, next = 0) {
    busy = true; error = ''; records = []; showAll();
    try {
      const result = await window.athena.knowledge.retrieve(id ? { operation: 'flow', id } : { operation: 'flows', ...(messageId ? { messageId } : {}), ...(serviceId ? { serviceId } : {}), limit: 8, offset: next });
      records = result.items; selectedId = id; offset = next; nextOffset = result.nextOffset;
      if (id) remember(id);
      if (!records.length) error = 'No accessible flow under these bounds. Supporting sources may be unavailable or not yet investigated; this is not proof of absence.';
    } catch { error = 'Flow access and freshness could not be checked. Retry after checking source permissions.'; }
    finally { busy = false; }
  }
  onMount(() => { void load(recordId); });
</script>

<main>
  <header><div><div class="eyebrow">Source-backed flow · Read-only</div><h1>Request flows</h1></div><button disabled={busy} onclick={() => load(selectedId, offset)}>Check flow freshness</button></header>
  <div class="flow-content">
    <p><strong>Not a runtime trace.</strong> Implementation evidence takes precedence over documentation. Only explicit handoffs describe ordering or causality; asynchronous publication does not establish delivery or consumer completion. Alternatives are not concurrent unless explicitly identified. Unknown boundaries and omissions do not imply exhaustive execution-path coverage.</p>
    <p class="meta">Up to 6 steps / 8 handoffs · 20 result claims · shared 32-claim / 256-source / 24-KiB / 10-second inspection bounds. Browsing starts no model work.</p>
    {#if busy}<p role="status">Checking flow and supporting claims…</p>{/if}
    {#if error}<p role="status">{error}</p>{/if}
    {#if selected?.flow}
      <h2>{selected.topic}</h2><p>{selected.claim}</p><p class="meta">{status(selected.id)} · Semantic truth not independently certified</p>
      <button onclick={() => openKnowledge(selected.id)}>Operation evidence & annotations</button>
      <button onclick={() => openExplorer(selected.flow!.steps[0].service)}>Open system map</button>
      {#each selected.owners as owner}<button onclick={() => openConversation(owner.conversationId)}>Return to answer</button>{/each}
      {#if expanded}<p class="meta">S labels identify portions, not an execution sequence. Only evidenced parallel dispatch or joins are labeled; unknown joins do not establish synchronization.</p>{/if}
      <div class="visibility" role="status" aria-label="Hidden flow content">
        {hiddenSteps} hidden steps · {collapsed.length} collapsed portions · {hiddenEdges} hidden handoffs
        <button onclick={showAll} disabled={focused === undefined && !collapsed.length}>Show all portions</button>
      </div>
      <ol class:graph={expanded} aria-label={expanded ? 'Operation flow portions' : 'Ordered operation steps'}>
        {#each selected.flow.steps as step, index}
          {#if focused === undefined || focused === index}
            {@const service = support(step.service)}
            {@const claim = support(step.claim)}
            {@const outgoing = edges.map((edge, edgeIndex) => ({ ...edge, edgeIndex })).filter(edge => edge.from === index)}
            <li class:stale={claim?.freshness === 'stale'}>
              {#if expanded}<span class="portion-marker">S{index + 1}{step.kind ? ` · ${kindLabel(step)}` : ''}</span>{/if}
              <h3>{step.name}</h3>
              <div class="portion-controls">
                <button aria-expanded={!collapsed.includes(index)} onclick={() => { collapsed = collapsed.includes(index) ? collapsed.filter(item => item !== index) : [...collapsed, index]; }}>{collapsed.includes(index) ? 'Expand' : 'Collapse'}: {step.name}</button>
                <button onclick={() => { focused = focused === index ? undefined : index; }}>{focused === index ? 'Clear focus' : 'Focus'}: {step.name}</button>
              </div>
              {#if collapsed.includes(index)}
                <p class="meta">1 step’s details and {outgoing.length} outgoing handoffs hidden.</p>
              {:else}
                <p>{step.state === 'unknown' ? 'Unknown / missing implementation' : step.state === 'documented' ? 'Documented — not implementation proof' : 'Statically supported — not runtime-observed'} · {status(step.claim)}</p>
                <p>{claim?.claim}</p>
                {#if step.annotation}<p class="annotation">{step.annotation}</p>{/if}
                <button onclick={() => openExplorer(step.service)}>Service: {service?.scope} / {service?.topic}</button>
                {#if service?.architecture && ['external', 'unresolved'].includes(service.architecture.type)}<p>Explicit {service.architecture.type} boundary. Internal execution is not established.</p>{/if}
                <button onclick={() => openKnowledge(step.claim)}>Step evidence: {step.name}</button>
                {#each claim?.evidence ?? [] as item}<p class="location">{item.citation.repository?.name ?? item.citation.folder} · {item.citation.path}:{item.citation.start}–{item.citation.end}</p>{/each}
                {#if step.omissions}<div class="omissions"><strong>Step omissions</strong><ul>{#each step.omissions as omission}<li>{omission}</li>{/each}</ul></div>{/if}
                {#each outgoing as handoff}
                  <div class="handoff" class:asynchronous={handoff.kind === 'asynchronous'}>
                    {#if handoff.condition}<p class="condition">If: {handoff.condition}</p>{/if}
                    <strong>{handoffLabels[handoff.kind]}</strong>
                    {#if expanded}<p class="destination">To S{handoff.to + 1} · {selected.flow.steps[handoff.to].name}{focused !== undefined && focused !== handoff.to ? ' (hidden by focus)' : ''}</p>{/if}
                    {#if handoff.kind === 'asynchronous'}<p class="meta">Publication/handoff only; delivery, processing order and completion require separate evidence.</p>{/if}
                    {#if handoff.kind === 'unknown'}<p class="meta">Gap only: ordering, causality and synchronization are not established by this handoff.</p>{/if}
                    <p>{support(handoff.claim)?.claim}</p><p class="meta">Scope: {support(handoff.claim)?.scope} · {status(handoff.claim)}</p>
                    <button onclick={() => openKnowledge(handoff.claim)}>Handoff evidence {handoff.edgeIndex + 1}</button>
                    {#if handoff.omissions}<div class="omissions"><strong>Handoff omissions</strong><ul>{#each handoff.omissions as omission}<li>{omission}</li>{/each}</ul></div>{/if}
                  </div>
                {/each}
              {/if}
            </li>
          {/if}
        {/each}
      </ol>
      <section aria-label="Flow omissions"><h3>Known omissions & state not investigated</h3><ul>{#each selected.flow.omissions as omission}<li>{omission}</li>{/each}</ul></section>
      <button disabled={busy} onclick={() => { remember(''); void load(''); }}>Back to flow list</button>
    {:else if !busy}
      {#each records.filter(record => record.flow) as record (record.id)}
        <article><button onclick={() => load(record.id)}>{record.topic}</button><p>{record.summary}</p><p class="meta">{status(record.id)}</p></article>
      {/each}
      <nav aria-label="Flow pages"><button disabled={busy || offset === 0} onclick={() => load('', Math.max(0, offset - 8))}>Previous flows</button><button disabled={busy || nextOffset === undefined} onclick={() => load('', nextOffset)}>Next flows</button></nav>
    {/if}
  </div>
</main>

<style>
  .flow-content { padding: 20px 36px 36px; overflow-y: auto; min-height: 0; }
  p, li { font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
  .meta, .location { color: var(--muted); font-size: 11px; }
  .location, .portion-marker, .destination { font-family: 'SFMono-Regular', Consolas, monospace; }
  .portion-marker { color: var(--accent); font-size: 11px; }
  ol { padding-left: 24px; max-width: 950px; }
  ol.graph { padding-left: 0; list-style: none; }
  ol > li { padding: 12px 16px; border-top: 1px solid var(--border); }
  h2 { font-size: 21px; } h3 { font-size: 16px; font-weight: 500; }
  .handoff { margin-top: 20px; padding: 12px; background: var(--panel); border-left: 2px solid var(--accent); }
  .handoff.asynchronous { border-left-style: dashed; }
  .condition { font-weight: 600; margin-top: 0; }
  .visibility { margin-top: 24px; padding: 12px 0; border-top: 1px solid var(--border); font-size: 12px; }
  .portion-controls { display: flex; flex-wrap: wrap; gap: 8px; }
  .annotation, .omissions { padding-left: 12px; border-left: 1px solid var(--border); }
  .stale { border-left: 2px dashed var(--muted); }
  article { padding: 16px 0; border-top: 1px solid var(--border); }
  nav { display: flex; gap: 12px; margin-top: 20px; }
</style>
