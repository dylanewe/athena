<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { KnowledgeRecord } from '../shared/knowledge';
  import type { Evidence } from '../shared/live';
  let { messageId = '', openConversation }: { messageId?: string; openConversation: (id: string) => void } = $props();
  let records = $state<KnowledgeRecord[]>([]);
  let error = $state('');
  let busy = $state(true);
  let onlyMessage = $state(true);
  let inspected = $state<Record<string, string>>({});
  const visible = $derived(messageId && onlyMessage ? records.filter(record => record.owners.some(owner => owner.messageId === messageId)) : records);
  async function load() {
    busy = true; error = '';
    try { records = await window.athena.knowledge.inspect(); }
    catch { error = 'Knowledge could not be loaded. Check source permissions and retry.'; }
    finally { busy = false; }
  }
  async function showClaim(id: string) {
    onlyMessage = false;
    await tick();
    document.getElementById(id)?.scrollIntoView({ block: 'center' });
  }
  async function inspect(key: string, evidence: Evidence) {
    const c = evidence.citation;
    try {
      const result = await window.athena.sources.run('read', { root: c.folder, path: c.path, start: c.start, end: c.end });
      const entry = result.entries.find(entry => entry.citation);
      inspected[key] = entry ? `${entry.citation?.contentIdentity === c.contentIdentity ? 'Matches retained content.' : 'Changed — this is not the retained version.'}\n\n${entry.text}` : 'Current file is unavailable or withheld. A reconnected repository may have moved; inspect its new location in Sources.';
    } catch { inspected[key] = 'Current file unavailable. Finish other source browsing and retry.'; }
  }
  onMount(() => { void load(); });
</script>

<main>
  <header><div><div class="eyebrow">Source-backed · On this Mac</div><h1>Knowledge</h1></div><button disabled={busy} onclick={load}>Check freshness</button></header>
  <div class="knowledge-content">
    <p class="intro">Concise architectural and domain findings, separate from your conversations. Static inspection is not runtime observation.</p>
    <p class="meta">References and file identities are checked by Athena; that does not certify a model's interpretation. Declarations, intent and historical decisions are not proof of current implementation. Implementation evidence takes precedence.</p>
    {#if messageId}<label class="filter"><input type="checkbox" bind:checked={onlyMessage} /> Only knowledge from this answer</label>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if busy}<p role="status">Checking inspected-file dependencies…</p>{:else if !visible.length}<p>No retained knowledge here yet. Completed, unexposed investigations can retain concise cited candidates; failed or canceled extraction cannot publish.</p>{/if}
    {#each visible as record (record.id)}
      <article class:stale={record.validation === 'stale'} id={record.id}>
        <div class="topic"><div><div class="eyebrow">{record.scope} · {record.kind}</div><h2>{record.topic}</h2></div><span class="validation">{record.validation}</span></div>
        <p>{record.summary}</p>
        <blockquote>{record.claim}</blockquote>
        <p class="meta">{record.provenance === 'declared' ? 'Declared in source' : 'Statically inferred'} · {record.perspective === 'current' ? 'Current-source interpretation' : record.perspective === 'intended' ? 'Intended behavior, not implementation' : 'Historical decision, not current behavior'}</p>
        <p class="meta">{record.validationNote}</p>
        {#if record.relations.length}<strong>Claim relationships</strong><ul>{#each record.relations as relation}<li>{relation.kind} · <a href={`#${relation.target}`} onclick={event => { event.preventDefault(); void showClaim(relation.target); }}>{relation.target}</a>{#each relation.owners as owner}<button onclick={() => openConversation(owner.conversationId)}>Relationship source</button>{/each}</li>{/each}</ul>{/if}
        <details><summary>Evidence ({record.evidence.length})</summary>
          {#each record.evidence as evidence, index}
            <div class="citation"><strong>{evidence.citation.path}:{evidence.citation.start}–{evidence.citation.end}</strong>
              <p class="meta">{evidence.citation.repository?.name ?? 'Non-Git document'} · {evidence.citation.folder}<br />{evidence.citation.revision ?? 'Revision unavailable'} · {evidence.citation.contentIdentity}</p>
              <pre>{evidence.text}</pre>
              <button onclick={() => inspect(`${record.id}:${index}`, evidence)}>Inspect current file</button>
              {#if inspected[`${record.id}:${index}`]}<pre>{inspected[`${record.id}:${index}`]}</pre>{/if}
            </div>
          {/each}
        </details>
        <details><summary>Inspected-file dependencies ({record.dependencies.length})</summary><ul>{#each record.dependencies as item}<li>{item.repository?.name ?? item.folder} · {item.path} · {item.contentIdentity}</li>{/each}</ul></details>
        {#if record.scopes.length}<details><summary>Inspected search/list scopes ({record.scopes.length})</summary><ul>{#each record.scopes as scope}<li>{scope.operation} · {scope.repository?.name ?? scope.folder} · {scope.path}{scope.query ? ` · ${scope.query}` : ''} · {scope.contentIdentity}</li>{/each}</ul></details>{/if}
        <details><summary>Originating answers ({record.owners.length})</summary>{#each record.owners as owner}<p><button onclick={() => openConversation(owner.conversationId)}>Open conversation</button> <span class="meta">{owner.messageId}</span></p>{/each}</details>
        <p class="identity">{record.id}</p>
      </article>
    {/each}
  </div>
</main>

<style>
  .knowledge-content { padding: 20px 36px 36px; overflow-y: auto; min-height: 0; }
  .intro { max-width: 700px; font-size: 13px; line-height: 1.7; }
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
</style>
