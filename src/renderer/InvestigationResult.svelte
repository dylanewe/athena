<script lang="ts">
  import type { InvestigatorResult } from '../shared/investigation';
  import type { KnowledgePublication } from '../shared/live';
  let { result, publication }: { result: InvestigatorResult; publication?: KnowledgePublication } = $props();
</script>

<p class="draft-note">Static source inspection, not runtime observation.</p>
<strong>Inspected scope</strong>
<ul>{#each result.inspectedScope as location}<li>{location}</li>{/each}</ul>
{#if result.scopeTruncated}<p class="draft-note">Scope display is truncated; coverage is incomplete.</p>{/if}
{#each result.findings as finding}
  <p>{finding.claim} · {finding.support === 'source' ? 'Source-supported' : 'Uncertain interpretation'} {finding.evidenceIds.map(id => `[${id}]`).join(' ')}</p>
{/each}
{#if result.unresolvedQuestions.length}
  <strong>Unresolved questions</strong>
  <ul>{#each result.unresolvedQuestions as question}<li>{question}</li>{/each}</ul>
{/if}
{#if result.knowledgeCandidates?.length}
  <strong>Normalization candidates · {publication === 'published' ? 'retained with validation labels' : 'not published'}</strong>
  {#each result.knowledgeCandidates as candidate}
    <details><summary>{candidate.scope} · {candidate.topic}</summary>
      <p>{candidate.summary}</p><p>{candidate.claim}</p>
      <p class="draft-note">{candidate.provenance} · {candidate.perspective} · {candidate.evidenceIds.map(id => `[${id}]`).join(' ')} · Semantic truth not certified</p>
      {#each candidate.relations as relation}<p class="draft-note">{relation.kind} · {relation.target}</p>{/each}
    </details>
  {/each}
{/if}
{#if result.candidateKnowledgeChanges.length}
  <strong>Candidate knowledge changes (not applied)</strong>
  <ul>{#each result.candidateKnowledgeChanges as change}<li>{change}</li>{/each}</ul>
{/if}

<style>
  details { padding: 8px 0; }
  summary { cursor: pointer; overflow-wrap: anywhere; }
  li, .draft-note { overflow-wrap: anywhere; }
</style>
