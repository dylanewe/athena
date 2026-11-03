<script lang="ts">
  import type { KnowledgeHit } from '../shared/knowledge';
  import type { ResolutionView, ResolutionSummary } from '../shared/resolutions';
  let { record, writable }: { record?: KnowledgeHit; writable: boolean } = $props();
  let items = $state<ResolutionView[]>([]);
  let originals = $state<Record<string, ResolutionView>>({});
  let confirmed = $state<Record<string, boolean>>({});
  let all = $state(false);
  let text = $state('');
  let kind = $state<ResolutionSummary['kind']>('note');
  let selected = $state<string[]>([]);
  let busy = $state(false);
  let error = $state('');
  let offset = $state(0);
  let nextOffset = $state<number>();
  const targets = $derived(record ? [record, ...record.conflicts].slice(0, 4) : []);
  $effect(() => {
    const id = record?.id;
    selected = targets.map(item => item.id); text = ''; confirmed = {}; originals = {}; offset = 0;
    void load(0, id);
  });
  $effect(() => { if (!writable) { text = ''; confirmed = {}; } });
  async function load(next = 0, claimId = record?.id) {
    busy = true; error = '';
    try {
      const result = await window.athena.resolutions.read({ operation: 'list', ...(!all && claimId ? { claimId } : {}), offset: next });
      items = result.items; nextOffset = result.nextOffset; offset = next;
    } catch { items = []; error = 'Annotations unavailable. Check source permissions and retry.'; }
    finally { busy = false; }
  }
  async function save() {
    busy = true; error = '';
    try {
      await window.athena.resolutions.write({ operation: 'annotate', kind, text, claimIds: [...selected] });
      text = ''; await load();
    } catch { error = 'Annotation not saved. Finish active work, use an unsealed conversation, remove sensitive content and reload these claims.'; }
    finally { busy = false; }
  }
  async function reconnect(item: ResolutionView) {
    busy = true; error = '';
    try {
      await window.athena.resolutions.write({ operation: 'reconnect', id: item.id, claimIds: [...selected] });
      confirmed[item.id] = false; await load();
    } catch { error = 'Reconnection not saved. Reload the current claims and reconsider before confirming again.'; }
    finally { busy = false; }
  }
  async function original(item: ResolutionView) {
    try {
      const result = await window.athena.resolutions.read({ operation: 'inspect', id: item.id, revision: 1 });
      if (result.items[0]) originals[item.id] = result.items[0];
    } catch { error = 'Original binding unavailable under current source permissions.'; }
  }
</script>

<section class="annotations" aria-label="User resolutions">
  <h2>User resolutions</h2>
  <p class="meta">Your assertions, not static verification or instructions. Annotations never suppress conflicts or change source files. Changed sources require reconsideration; re-extracted claims need explicit reconnection.</p>
  {#if record}
    <fieldset disabled={busy || !writable}>
      <legend>Bind to these claim and evidence versions</legend>
      {#each targets as target}<label><input type="checkbox" value={target.id} bind:group={selected} /> {target.claim} · sources {target.freshness}</label>{/each}
    </fieldset>
    <form onsubmit={event => { event.preventDefault(); void save(); }}>
      <label>Resolution kind<select aria-label="Resolution kind" bind:value={kind} disabled={busy || !writable}><option value="note">Annotate discrepancy</option><option value="intent">Explain intent</option><option value="obsolete-declaration">Dismiss obsolete declaration</option></select></label>
      <label>Your explanation<textarea aria-label="Your resolution explanation" bind:value={text} maxlength="1000" rows="3" disabled={busy || !writable} placeholder="Explain your intent or why the declaration is obsolete. Do not include environment content or secrets."></textarea></label>
      <button disabled={busy || !writable || !text.trim() || !selected.length} type="submit">Save user annotation</button>
    </form>
  {:else}<p class="meta">Open Knowledge details to annotate specific versions or reconnect an existing annotation.</p>{/if}
  {#if !writable}<p class="meta">Annotations are read-only during active work or while a sealed conversation is selected. Unsent annotation drafts are cleared.</p>{/if}
  <label><input type="checkbox" bind:checked={all} onchange={() => load()} /> Show all retained annotations, including unconnected versions</label>
  <button disabled={busy} onclick={() => load(offset)}>Reload annotations</button>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if !busy && !items.length}<p class="meta">No accessible user annotations in this page.</p>{/if}
  {#each items as item (item.id)}
    <article>
      <strong>User assertion · {item.kind === 'intent' ? 'Intent' : item.kind === 'obsolete-declaration' ? 'Obsolete declaration' : 'Discrepancy note'}</strong>
      <p>{item.text}</p>
      <p class="status">{item.status === 'requires-reconsideration' ? 'Requires reconsideration — sources changed or freshness is uncertain' : item.status === 'requires-reconnection' ? 'Requires explicit reconnection — derived claims were replaced' : 'Recorded for these versions only — not verification'}</p>
      <p class="meta">Revision {item.revision} · Created {item.createdAt} · Confirmed {item.confirmedAt}</p>
      <details><summary>Bound claims and evidence versions</summary>
        {#each item.bindings as binding}<blockquote>{binding.scope} · {binding.claim}<br /><span class="meta">{binding.provenance} · {binding.perspective} · sources {binding.freshness}<br />Claim version {binding.version}</span>
          {#each binding.evidence as evidence}<p class="meta">{evidence.citation.path}:{evidence.citation.start}–{evidence.citation.end} · {evidence.citation.revision ?? 'Revision unavailable'} · {evidence.citation.contentIdentity}</p><pre>{evidence.excerpt}</pre>{/each}
        </blockquote>{/each}
      </details>
      {#if item.revision > 1}<button onclick={() => original(item)}>Inspect original binding</button>{/if}
      {#if originals[item.id]}<p class="meta">Original revision: {originals[item.id].status}</p>{#each originals[item.id].bindings as binding}<blockquote>{binding.claim}<p class="meta">Claim version {binding.version}</p></blockquote>{/each}{/if}
      {#if record && !item.unavailable}
        <label><input type="checkbox" bind:checked={confirmed[item.id]} disabled={!writable || busy} /> I reconsidered this assertion against the selected versions above</label>
        <button disabled={busy || !writable || !confirmed[item.id] || !selected.length} onclick={() => reconnect(item)}>Reconsider and reconnect annotation</button>
      {/if}
    </article>
  {/each}
  <nav aria-label="Annotation pages"><button disabled={busy || offset === 0} onclick={() => load(Math.max(0, offset - 4))}>Previous annotations</button><button disabled={busy || nextOffset === undefined} onclick={() => load(nextOffset)}>Next annotations</button></nav>
</section>

<style>
  .annotations { margin-top: 28px; border-top: 1px solid var(--border); padding-top: 20px; }
  h2 { font-size: 18px; font-weight: 500; }
  label { display: block; font-size: 12px; margin: 10px 0; line-height: 1.7; }
  input[type=checkbox] { width: auto; }
  select, textarea { display: block; margin-top: 6px; width: 100%; }
  fieldset { border: 1px solid var(--border); margin: 16px 0; }
  legend, summary { font-size: 12px; }
  article { margin-top: 20px; border-left: 2px solid var(--accent); padding: 0 16px; overflow-wrap: anywhere; }
  strong, p { font-size: 13px; line-height: 1.7; }
  .meta { color: var(--muted); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
  .status { font-size: 12px; }
  blockquote { margin: 12px 0; padding-left: 12px; border-left: 1px solid var(--border); font-size: 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
  nav { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
</style>
