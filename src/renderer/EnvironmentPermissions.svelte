<script lang="ts">
  import { ENVIRONMENT_WARNING, type EnvironmentAction, type EnvironmentPermission } from '../shared/environment';
  let { permissions, act, busy }: { permissions: EnvironmentPermission[]; act(id: string, action: EnvironmentAction): void; busy: boolean } = $props();
</script>

<section class="environment-permissions" aria-label="Environment-file permissions">
  <div class="eyebrow">Current investigation only</div>
  <h2>Protected environment file</h2>
  <p>{ENVIRONMENT_WARNING}</p>
  {#each permissions as permission (permission.id)}
    <div class="permission">
      <strong>{permission.path}</strong>
      <p class="location">{permission.root}</p>
      <p>Actual environment file is protected.{permission.waiting ? ' The investigator is waiting for your choice.' : ''}</p>
      <div class="actions">
        <button disabled={busy || permission.local} onclick={() => act(permission.id, 'local')}>{permission.local ? 'Local inspection approved' : 'Approve local inspection'}</button>
        <button disabled={busy || permission.external} onclick={() => act(permission.id, 'external')}>{permission.external ? 'External processing approved' : 'Approve external processing'}</button>
        {#if permission.waiting}<button disabled={busy} onclick={() => act(permission.id, 'deny')}>Continue without this file</button>{/if}
        {#if permission.local || permission.external}<button disabled={busy} onclick={() => act(permission.id, 'revoke')}>Revoke and stop investigation</button>{/if}
      </div>
      {#if permission.preview !== undefined}
        <div class="eyebrow">Ephemeral · Local only · Not saved</div>
        <pre aria-label="Ephemeral local preview">{permission.preview}</pre>
      {/if}
    </div>
  {/each}
</section>

<style>
  .environment-permissions { border: 1px solid var(--accent); padding: 16px; margin: 16px 24px; font-size: 13px; }
  h2 { font-size: 18px; margin: 8px 0; }
  .permission { border-top: 1px solid var(--accent); padding-top: 12px; margin-top: 12px; }
  .location, strong, pre { overflow-wrap: anywhere; }
  .location { font-family: monospace; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
  pre { white-space: pre-wrap; max-height: 240px; overflow: auto; }
</style>
