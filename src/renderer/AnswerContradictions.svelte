<script lang="ts">
  import { onMount } from 'svelte';
  import type { KnowledgeHit } from '../shared/knowledge';
  import Contradictions from './Contradictions.svelte';
  let { messageId }: { messageId: string } = $props();
  let records = $state<KnowledgeHit[]>([]);
  onMount(() => {
    let mounted = true;
    void window.athena.knowledge.retrieve({ operation: 'search', query: '', messageId, limit: 8 }).then(result => {
      const seen = new Set<string>();
      if (mounted) records = result.items.filter(item => {
        if (!item.conflicts.length || seen.has(item.id)) return false;
        seen.add(item.id); for (const other of item.conflicts) seen.add(other.id);
        return true;
      });
    }).catch(() => {});
    return () => { mounted = false; };
  });
</script>

{#each records as record (record.id)}<Contradictions {record} />{/each}
