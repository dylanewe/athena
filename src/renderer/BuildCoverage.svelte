<script lang="ts">
  import type { BuildCoverage } from '../shared/build';
  let { coverage, status, openConversation }: { coverage: BuildCoverage; status: string; openConversation: (id: string) => void } = $props();
</script>

<section class="build-coverage" aria-label="Knowledge build coverage">
  <strong>Knowledge build · {status === 'limit' ? 'limit-paused' : status}</strong>
  <p>Selected repositories: {coverage.repositories.join(', ')}</p>
  {#if coverage.reusedRepositories.length}<p>Reused unchanged knowledge: {coverage.reusedRepositories.join(', ')}. Previous gaps remain unknown.</p>{/if}
  {#each coverage.reusedFrom as previous}<button type="button" onclick={() => openConversation(previous.conversationId)}>Review previous coverage: {previous.repository}</button>{/each}
  <p>{coverage.notice}</p>
  {#if coverage.truncated}<p>Partial coverage: source or reporting limits reached. Retry explicitly; no automatic continuation.</p>{/if}
  <details open><summary>Source coverage · {coverage.inspected.length} requests this build</summary>
    {#if !coverage.inspected.length}<p>No fresh source excerpts inspected in this build.</p>{/if}
    <ul>{#each coverage.inspected as item}<li>{item.operation} · {item.root}/{item.path} · {item.status}</li>{/each}</ul>
  </details>
  <details><summary>Unsupported or withheld inputs · {coverage.unsupported.length}</summary>
    <ul>{#each coverage.unsupported as item}<li>{item.root}/{item.path} · {item.reason}</li>{/each}</ul>
    <p>Only encountered inputs are listed. Unvisited material remains unknown.</p>
  </details>
  <details open={coverage.failures.length > 0}><summary>Failures · {coverage.failures.length}</summary><ul>{#each coverage.failures as failure}<li>{failure}</li>{/each}</ul></details>
  <details open={coverage.unresolved.length > 0}><summary>Unresolved references and gaps · {coverage.unresolved.length}</summary><ul>{#each coverage.unresolved as gap}<li>{gap}</li>{/each}</ul></details>
</section>

<style>
  .build-coverage { border-left: 3px solid var(--accent); padding: 12px 16px; background: var(--accent-surface); margin: 12px 0; font-size: 12px; overflow-wrap: anywhere; }
  p, li { line-height: 1.6; }
  summary { cursor: pointer; margin: 8px 0; }
  li { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 11px; margin: 5px 0; }
</style>
