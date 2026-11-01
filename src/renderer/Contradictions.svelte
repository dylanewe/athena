<script lang="ts">
  import type { KnowledgeHit } from '../shared/knowledge';
  let { record }: { record: KnowledgeHit } = $props();
</script>

{#if record.conflicts.length}
  <section class="contradiction" aria-label="Contradictory claims">
    <h3>Contradictory claims</h3>
    <p>Implementation evidence takes precedence for implemented behavior. Static interpretation is not runtime observation or semantic verification. Intent, historical declarations and user assertions do not establish current behavior.</p>
    <div class="trails">
      {#each [record, ...record.conflicts] as trail (trail.id)}
        <div class="trail">
          <strong>{trail.provenance === 'declared' ? 'Declaration' : 'Static interpretation'} · {trail.perspective}</strong>
          <blockquote>{trail.claim}</blockquote>
          <p>Sources {trail.freshness} · {trail.validation}</p>
          {#each trail.evidence.filter(item => item.excerpt !== undefined) as item}
            <div class="source">{item.citation.repository?.name ?? 'Non-Git document'} · {item.citation.path}:{item.citation.start}–{item.citation.end}<br />{item.citation.revision ?? 'Revision unavailable'} · {item.citation.contentIdentity}</div>
            <pre>{item.excerpt}</pre>
            {#if item.truncated}<p>Excerpt bounded; inspect knowledge evidence for more.</p>{/if}
          {/each}
        </div>
      {/each}
    </div>
    {#if record.truncated}<p>Some trails or details were omitted by access or retrieval bounds. This does not resolve the conflict.</p>{/if}
  </section>
{/if}

<style>
  .contradiction { border: 1px solid var(--border); margin: 18px 0; padding: 16px; }
  h3 { margin: 0; font-size: 14px; font-weight: 500; }
  p, .source { color: var(--muted); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
  .trails { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 20px; }
  .trail { border-top: 2px solid var(--accent); padding-top: 12px; min-width: 0; }
  strong { font-size: 12px; font-weight: 500; }
  blockquote { margin: 12px 0; font-size: 13px; line-height: 1.7; }
  .source, pre { font-family: 'SFMono-Regular', Consolas, monospace; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; line-height: 1.7; }
</style>
