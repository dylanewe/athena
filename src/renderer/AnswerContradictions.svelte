<script lang="ts">
  import { onMount } from 'svelte';
  import type { KnowledgeHit } from '../shared/knowledge';
  import Contradictions from './Contradictions.svelte';
  let { messageId, references = [] }: { messageId?: string; references?: Pick<KnowledgeHit, 'id'>[] } = $props();
  let records = $state<KnowledgeHit[]>([]);
  onMount(() => {
    let mounted = true;
    const requests = [
      ...(messageId ? [{ operation: 'search' as const, query: '', messageId, limit: 8 }] : []),
      ...references.slice(0, 8).map(reference => ({ operation: 'detail' as const, id: reference.id })),
    ];
    void Promise.all(requests.map(request => window.athena.knowledge.retrieve(request).catch(() => ({ items: [] })))).then(results => {
      const seen = new Set<string>();
      if (mounted) records = results.flatMap(result => result.items).filter(item => {
        if (!item.conflicts.length || seen.has(item.id)) return false;
        seen.add(item.id); for (const other of item.conflicts) seen.add(other.id);
        return true;
      });
    }).catch(() => {});
    return () => { mounted = false; };
  });
</script>

{#each records as record (record.id)}<Contradictions {record} />{/each}
