<script lang="ts">
  import { onMount, tick } from 'svelte';
  import EnvironmentPermissions from './EnvironmentPermissions.svelte';
  import InventoryView from './Inventory.svelte';
  import SourcesView from './Sources.svelte';
  import ModelSettingsView from './ModelSettings.svelte';
  import { MAX_MESSAGE_LENGTH, type Workspace } from '../shared/contracts';
  import type { Evidence } from '../shared/live';
  let defaultModel = $state<string | null>(null);
  let inspected = $state<Record<string, string>>({});

  let section = $state<'conversation' | 'inventory' | 'models' | 'sources'>('conversation');
  let workspace = $state<Workspace | null>(null);
  let error = $state('');
  let busy = $state(false);
  let composingNew = $state(false);
  let drafts = $state<Record<string, string>>({ new: '' });
  let messageInput = $state<HTMLTextAreaElement>();
  let transcript = $state<HTMLDivElement>();
  let requestNumber = 0;
  const sealedSeen = new Set<string>();
  const selected = $derived(composingNew ? null : workspace?.selected);
  const draftKey = $derived(selected?.id ?? 'new');
  const active = $derived(workspace?.activeConversationId);
  const conversationUsage = $derived.by(() => {
    if (!selected?.kind || selected.kind === 'demo') return null;
    const replies = selected.messages.filter(message => message.role === 'assistant');
    if (!replies.some(message => message.requests !== undefined)) return null;
    return {
      requests: replies.reduce((sum, message) => sum + (message.requests ?? 0), 0),
      input: replies.reduce((sum, message) => sum + (message.usage?.input ?? 0), 0),
      output: replies.reduce((sum, message) => sum + (message.usage?.output ?? 0), 0),
      cachedInput: replies.reduce((sum, message) => sum + (message.usage?.cachedInput ?? 0), 0),
      reported: replies.some(message => message.usage !== undefined),
      complete: replies.every(message => message.usageComplete === true),
    };
  });

  async function load() {
    // A mutation owns its response. Notifications during it are refreshed after it settles.
    if (busy) return;
    const number = ++requestNumber;
    try {
      const [next, settings, api] = await Promise.all([window.athena.workspace(), window.athena.chatgpt.snapshot(), window.athena.apiModels.snapshot()]);
      if (number === requestNumber) {
        for (const conversation of next.conversations) if (conversation.sealed && !sealedSeen.has(conversation.id)) {
          sealedSeen.add(conversation.id); drafts = { new: '' }; inspected = {};
        }
        workspace = next; defaultModel = api.route === 'api-key' ? 'API key · ' + api.conversation : settings.selectedModel; }
    } catch { error = 'Could not load conversations. Restart Athena to try again.'; }
  }

  async function change(action: () => Promise<Workspace>): Promise<boolean> {
    if (busy) return false;
    busy = true;
    error = '';
    ++requestNumber;
    try {
      workspace = await action();
      return true;
    } catch (failure) {
      error = (failure instanceof Error ? failure.message : 'Could not save this change.') + ' Your draft is still here.';
      return false;
    } finally { busy = false; void load(); }
  }

  async function newConversation() {
    section = 'conversation';
    composingNew = true;
    error = '';
    await tick();
    messageInput?.focus();
  }
  async function select(id: string) {
    if (await change(() => window.athena.select(id))) {
      section = 'conversation';
      composingNew = false;
    }
  }
  async function send() {
    if (!workspace || busy || active) return;
    const id = selected?.id ?? null;
    const key = draftKey;
    const text = drafts[key] ?? '';
    if (!text.trim()) return;
    if (await change(() => window.athena.send(id, text))) {
      drafts[key] = '';
      composingNew = false;
    }
  }

  async function inspectEvidence(key: string, evidence: Evidence) {
    const c = evidence.citation;
    inspected[key] = 'Checking current file…';
    try {
      const result = await window.athena.sources.run('read', { root: c.folder, path: c.path, start: c.start, end: c.end });
      const entry = result.entries.find(entry => entry.citation);
      inspected[key] = entry ? `${entry.citation?.contentIdentity === c.contentIdentity ? 'Matches cited content.' : 'Changed since this answer — do not treat this as the cited version.'}\n\n${entry.text}` : 'Current file is unavailable or withheld by source policy.';
    } catch { inspected[key] = 'Current file could not be inspected. Finish other source browsing and retry.'; }
  }

  onMount(() => {
    const unsubscribe = window.athena.onChange(() => { void load(); });
    void load();
    return unsubscribe;
  });
  $effect(() => {
    // Scroll only the transcript, not the composer or navigation.
    selected?.messages;
    void tick().then(() => transcript?.scrollTo({ top: transcript.scrollHeight }));
  });
</script>

<div class="workspace">
  <aside aria-label="Conversations">
    <div class="brand"><span class="brand-mark" aria-hidden="true">a.</span><span>Athena</span></div>
    <button class="new-conversation" aria-pressed={section === 'inventory'} onclick={() => section = section === 'inventory' ? 'conversation' : 'inventory'}>Repositories</button>
    <button class="new-conversation" aria-pressed={section === 'sources'} onclick={() => section = section === 'sources' ? 'conversation' : 'sources'}>Sources</button>
    <button class="new-conversation" aria-pressed={section === 'models'} onclick={() => section = section === 'models' ? 'conversation' : 'models'}>Model settings</button>
    <div class="sidebar-heading">Your conversations</div>
    <button class="new-conversation" onclick={newConversation} disabled={busy || !workspace}><span aria-hidden="true">+</span> New conversation</button>
    <nav aria-label="Saved conversations">
      {#each workspace?.conversations ?? [] as conversation (conversation.id)}
        <button class:selected={selected?.id === conversation.id}
          aria-current={selected?.id === conversation.id ? 'page' : undefined}
          disabled={busy} onclick={() => select(conversation.id)}>
          <span class="conversation-icon" aria-hidden="true">↳</span>
          <span>{conversation.title}</span>
          {#if active === conversation.id}<span class="running-dot" aria-label={workspace?.saveError ? 'Not saved' : 'Running'}></span>{/if}
        </button>
      {/each}
    </nav>
    <div class="local-note"><span class="eyebrow">On this Mac</span><p>History is saved here.<br />Live questions use the pinned route.</p></div>
  </aside>

  {#if section === 'inventory'}
    <InventoryView />
  {:else if section === 'sources'}
    <SourcesView />
  {:else if section === 'models'}
    <ModelSettingsView />
  {:else}
    <main>
      {#if workspace?.environment?.length}
        <EnvironmentPermissions permissions={workspace.environment} {busy} act={(id, action) => { void change(() => window.athena.environment(id, action)); }} />
      {/if}
      {#if error || workspace?.saveError}<div class="error" role="alert">{error || workspace?.saveError}</div>{/if}
      {#if !workspace}
        <p class="empty-copy">Loading your conversations…</p>
      {:else}
        {#if selected}
          <div class="transcript" bind:this={transcript} role="log" aria-label="Messages" aria-live="polite">
            {#each selected.messages as message (message.id)}
              <article class:user={message.role === 'user'} class="message">
                <div class="message-heading"><strong>{message.role === 'user' ? 'You' : 'Athena'}</strong>
                  {#if message.role === 'assistant'}<span class:problem={!['running', 'complete'].includes(message.status)}>{message.status === 'running' && workspace.saveError ? 'Not saved' : message.status === 'complete' && !selected.model ? 'Local demo' : message.status === 'limit' ? 'limit-paused' : message.status}</span>{/if}
                </div>
                {#if message.ephemeral}<p class="draft-note">Ephemeral · Not saved · May contain sensitive values</p>{/if}
                <p>{message.text}</p>
                {#if message.status === 'running' && message.activity}<p class="draft-note">{message.activity}</p>{/if}
                {#if message.investigation}
                  <details class="evidence"><summary>Investigation · {message.status === 'running' ? 'in progress' : message.investigation.status}</summary>
                    <p class="draft-note">Static source inspection, not runtime observation.</p>
                    <strong>Inspected scope</strong>
                    <ul>{#each message.investigation.inspectedScope as location}<li>{location}</li>{/each}</ul>
                    {#if message.investigation.scopeTruncated}<p class="draft-note">Scope display is truncated; detailed exploration is retained locally.</p>{/if}
                    {#each message.investigation.findings as finding}
                      <p>{finding.claim} · {finding.support === 'source' ? 'Source-supported' : 'Uncertain interpretation'} {finding.evidenceIds.map(id => `[${id}]`).join(' ')}</p>
                    {/each}
                    {#if message.investigation.unresolvedQuestions.length}
                      <strong>Unresolved questions</strong>
                      <ul>{#each message.investigation.unresolvedQuestions as question}<li>{question}</li>{/each}</ul>
                    {/if}
                    {#if message.investigation.candidateKnowledgeChanges.length}
                      <strong>Candidate knowledge changes (not applied)</strong>
                      <ul>{#each message.investigation.candidateKnowledgeChanges as change}<li>{change}</li>{/each}</ul>
                    {/if}
                  </details>
                {/if}
                {#if message.evidence?.length}
                  <details class="evidence"><summary>Inspected evidence ({message.evidence.length})</summary>
                    {#each message.evidence as evidence (evidence.id)}
                      <details><summary>[{evidence.id}] {evidence.citation.path}:{evidence.citation.start}–{evidence.citation.end}</summary>
                        <p class="draft-note">{evidence.citation.folder} · {evidence.citation.revision ?? 'Revision unavailable'} · {evidence.citation.contentIdentity}</p>
                        <pre>{evidence.text}</pre>
                        <button type="button" onclick={() => inspectEvidence(`${message.id}:${evidence.id}`, evidence)}>Inspect current file</button>
                        {#if inspected[`${message.id}:${evidence.id}`]}<pre>{inspected[`${message.id}:${evidence.id}`]}</pre>{/if}
                      </details>
                    {/each}
                  </details>
                {/if}
                {#if !selected.sealed && selected.kind === 'chatgpt' && message.role === 'assistant' && !['running', 'complete'].includes(message.status) && selected.messages.at(-1)?.id === message.id}
                  <button type="button" disabled={busy || !!active} onclick={() => change(() => window.athena.retry(message.id))}>Retry</button>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
        <section class="chat-input" class:unsent={!selected} aria-label="Conversation composer">
          <div class="composer-heading">
            <div><div class="eyebrow">{selected ? 'Conversation' : 'Start with a question'}</div><h1>{selected?.title ?? 'New conversation'}</h1></div>
            <span class="demo-badge">{selected && !selected.model ? 'Local demo · Read-only' : selected?.model ?? defaultModel ?? 'ChatGPT · Select a model'}</span>
          </div>
          {#if !selected}<p class="draft-note">Send your first message to save this conversation. The selected model will suggest its title; a local title is kept if naming fails.</p>{/if}
          {#if selected && !selected.model}<p class="draft-note">This saved demonstration is read-only. Start a new conversation to use a configured provider.</p>{/if}
          {#if selected?.sealed}<p class="draft-note">This ephemeral investigation is sealed. Start a new conversation. Unsent drafts were cleared to avoid retaining derived sensitive content.</p>{/if}
          <form class="composer" onsubmit={(event) => { event.preventDefault(); void send(); }}>
            <label for="message">Message</label>
            <textarea id="message" bind:this={messageInput} bind:value={drafts[draftKey]} maxlength={MAX_MESSAGE_LENGTH} rows="3"
              disabled={busy || selected?.sealed || (!!selected && !selected.model)} placeholder="Ask a question or investigate your repositories…"
              onkeydown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }}></textarea>
            <div class="composer-actions">
              <span>{workspace.saveError ? 'Stopped · Result not saved' : active ? 'Working · 50 requests / 15 minutes maximum' : selected ? 'Saved locally' : 'Unsent'}</span>
              {#if active}
                <button type="button" disabled={busy} onclick={() => change(() => window.athena.cancel())}>{workspace.saveError ? 'Retry saving' : 'Stop'}</button>
              {:else}
                <button class="primary" aria-label="Send message" disabled={busy || selected?.sealed || (!!selected && !selected.model) || !(drafts[draftKey] ?? '').trim()}>Send <span aria-hidden="true">↗</span></button>
              {/if}
            </div>
          </form>
          {#if conversationUsage}
            <p class="draft-note" aria-label="Conversation usage">
              {conversationUsage.requests} model {conversationUsage.requests === 1 ? 'request' : 'requests'} · {conversationUsage.reported ? `${conversationUsage.input} input · ${conversationUsage.output} output · ${conversationUsage.cachedInput} cached input tokens` : 'Token usage unavailable'}{conversationUsage.complete ? '' : ' · Usage may be incomplete'} · No dollar estimate
            </p>
          {/if}
        </section>
      {/if}
    </main>
  {/if}
</div>

<style>
  .evidence { border-left: 2px solid var(--accent); padding: 8px 12px; margin: 12px 0; }
  .evidence details { padding: 8px 0; }
  .evidence summary { cursor: pointer; overflow-wrap: anywhere; }
  .evidence li { overflow-wrap: anywhere; }
  .evidence pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
  .evidence .draft-note { overflow-wrap: anywhere; }
</style>
