<script lang="ts">
  import { onMount } from 'svelte';
  import type { KnowledgeHit } from '../shared/knowledge';
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
  const selected = $derived(records.find(record => record.id === selectedId));
  function support(id: string) { return records.find(record => record.id === id); }
  function status(id: string) {
    const record = support(id);
    return record ? `Sources ${record.freshness} · ${record.provenance === 'declared' ? 'Documented' : 'Statically supported interpretation'} · ${record.perspective} · ${record.validation}${record.validation === 'unchecked' || record.validation === 'conflicting' ? ' · Uncertain interpretation' : ''}` : 'Support unavailable';
  }
  async function load(id = selectedId, next = 0) {
    busy = true; error = ''; records = [];
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
  <header><div><div class="eyebrow">Ordered source evidence · Read-only</div><h1>Request flows</h1></div><button disabled={busy} onclick={() => load(selectedId, offset)}>Check flow freshness</button></header>
  <div class="flow-content">
    <p><strong>Not a runtime trace.</strong> Ordering is an evidenced static interpretation, not observed execution. Implementation evidence takes precedence over documentation. Unknown boundaries, omitted state, failures and alternate branches do not imply exhaustive execution-path coverage.</p>
    <p class="meta">Up to 6 steps · 20 result claims · shared 32-claim / 256-source / 24-KiB / 10-second inspection bounds. Browsing starts no model work.</p>
    {#if busy}<p role="status">Checking flow and supporting claims…</p>{/if}
    {#if error}<p role="status">{error}</p>{/if}
    {#if selected?.flow}
      <h2>{selected.topic}</h2><p>{selected.claim}</p><p class="meta">{status(selected.id)} · Semantic truth not independently certified</p>
      <button onclick={() => openKnowledge(selected.id)}>Operation evidence & annotations</button>
      <button onclick={() => openExplorer(selected.flow!.steps[0].service)}>Open system map</button>
      {#each selected.owners as owner}<button onclick={() => openConversation(owner.conversationId)}>Return to answer</button>{/each}
      <ol aria-label="Ordered operation steps">
        {#each selected.flow.steps as step, index}
          {@const service = support(step.service)}
          {@const claim = support(step.claim)}
          <li class:stale={claim?.freshness === 'stale'}>
            <h3>{step.name}</h3>
            <p>{step.state === 'unknown' ? 'Unknown / missing implementation' : step.state === 'documented' ? 'Documented — not implementation proof' : 'Statically supported — not runtime-observed'} · {status(step.claim)}</p>
            <p>{claim?.claim}</p>
            <button onclick={() => openExplorer(step.service)}>Service: {service?.scope} / {service?.topic}</button>
            {#if service?.architecture && ['external', 'unresolved'].includes(service.architecture.type)}<p>Explicit {service.architecture.type} boundary. Internal execution is not established.</p>{/if}
            <button onclick={() => openKnowledge(step.claim)}>Step evidence: {step.name}</button>
            {#each claim?.evidence ?? [] as item}<p class="location">{item.citation.repository?.name ?? item.citation.folder} · {item.citation.path}:{item.citation.start}–{item.citation.end}</p>{/each}
            {#if selected.flow.handoffs[index]}
              {@const handoff = selected.flow.handoffs[index]}
              <div class="handoff"><strong>{handoff.kind === 'synchronous' ? 'Synchronous handoff →' : handoff.kind === 'unknown' ? 'Unknown handoff / gap →' : 'Within-service step →'}</strong>
                <p>{support(handoff.claim)?.claim}</p><p class="meta">{status(handoff.claim)}</p>
                <button onclick={() => openKnowledge(handoff.claim)}>Handoff evidence {index + 1}</button>
              </div>
            {/if}
          </li>
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
  .location { font-family: 'SFMono-Regular', Consolas, monospace; }
  ol { padding-left: 24px; max-width: 950px; }
  ol > li { padding: 12px 16px; border-top: 1px solid var(--border); }
  h2 { font-size: 21px; } h3 { font-size: 16px; font-weight: 500; }
  .handoff { margin-top: 20px; padding: 12px; background: var(--panel); border-left: 2px solid var(--accent); }
  .stale { border-left: 2px dashed var(--muted); }
  article { padding: 16px 0; border-top: 1px solid var(--border); }
  nav { display: flex; gap: 12px; margin-top: 20px; }
</style>
