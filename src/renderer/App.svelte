<script lang="ts">
  import { onMount, tick } from 'svelte';
  import InventoryView from './Inventory.svelte';
  import { MAX_MESSAGE_LENGTH, type Workspace } from '../shared/contracts';

  let inventoryOpen = $state(false);
  let workspace = $state<Workspace | null>(null);
  let error = $state('');
  let busy = $state(false);
  let composingNew = $state(false);
  let drafts = $state<Record<string, string>>({ new: '' });
  let messageInput = $state<HTMLTextAreaElement>();
  let transcript = $state<HTMLDivElement>();
  let requestNumber = 0;
  const selected = $derived(composingNew ? null : workspace?.selected);
  const draftKey = $derived(selected?.id ?? 'new');
  const active = $derived(workspace?.activeConversationId);

  async function load() {
    // A mutation owns its response. Notifications during it are refreshed after it settles.
    if (busy) return;
    const number = ++requestNumber;
    try {
      const next = await window.athena.workspace();
      if (number === requestNumber) workspace = next;
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
    } catch {
      error = 'Could not save this change. Your draft is still here. Try again.';
      return false;
    } finally { busy = false; void load(); }
  }

  async function newConversation() {
    inventoryOpen = false;
    composingNew = true;
    error = '';
    await tick();
    messageInput?.focus();
  }
  async function select(id: string) {
    if (await change(() => window.athena.select(id))) {
      inventoryOpen = false;
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
    <button class="new-conversation" aria-pressed={inventoryOpen} onclick={() => inventoryOpen = !inventoryOpen}>Repositories</button>
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
    <div class="local-note"><span class="eyebrow">On this Mac</span><p>Conversations stay here.<br />Close Athena. Pick up later.</p></div>
  </aside>

  {#if inventoryOpen}
    <InventoryView />
  {:else}
    <main>
      {#if error || workspace?.saveError}<div class="error" role="alert">{error || workspace?.saveError}</div>{/if}
      {#if !workspace}
        <p class="empty-copy">Loading your conversations…</p>
      {:else}
        {#if selected}
          <div class="transcript" bind:this={transcript} role="log" aria-label="Messages" aria-live="polite">
            {#each selected.messages as message (message.id)}
              <article class:user={message.role === 'user'} class="message">
                <div class="message-heading"><strong>{message.role === 'user' ? 'You' : 'Athena'}</strong>
                  {#if message.role === 'assistant'}<span class:problem={message.status === 'failed' || message.status === 'cancelled'}>{message.status === 'running' && workspace.saveError ? 'Not saved' : message.status === 'complete' ? 'Local demo' : message.status}</span>{/if}
                </div>
                <p>{message.text}</p>
              </article>
            {/each}
          </div>
        {/if}
        <section class="chat-input" class:unsent={!selected} aria-label="Conversation composer">
          <div class="composer-heading">
            <div><div class="eyebrow">{selected ? 'Conversation' : 'Start with a question'}</div><h1>{selected?.title ?? 'New conversation'}</h1></div>
            <span class="demo-badge">Local demo</span>
          </div>
          {#if !selected}<p class="draft-note">Send your first message to save this conversation. Its title will be derived locally from your prompt.</p>{/if}
          <form class="composer" onsubmit={(event) => { event.preventDefault(); void send(); }}>
            <label for="message">Message</label>
            <textarea id="message" bind:this={messageInput} bind:value={drafts[draftKey]} maxlength={MAX_MESSAGE_LENGTH} rows="3"
              disabled={busy} placeholder="Ask a question to try the local demo…"
              onkeydown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }}></textarea>
            <div class="composer-actions">
              <span>{workspace.saveError ? 'Demonstration stopped · Result not saved' : active ? 'Demonstration running. No paid work.' : selected ? 'Saved locally · No repository access · No model charges' : 'Unsent · No repository access · No model charges'}</span>
              {#if active}
                <button type="button" disabled={busy} onclick={() => change(() => window.athena.cancel())}>{workspace.saveError ? 'Retry saving' : 'Stop demonstration'}</button>
              {:else}
                <button class="primary" aria-label="Send message" disabled={busy || !(drafts[draftKey] ?? '').trim()}>Send <span aria-hidden="true">↗</span></button>
              {/if}
            </div>
          </form>
        </section>
      {/if}
    </main>
  {/if}
</div>
