<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH, type Workspace } from '../shared/contracts';

  let workspace = $state<Workspace | null>(null);
  let error = $state('');
  let busy = $state(false);
  let naming = $state(false);
  let title = $state('');
  let nameInput = $state<HTMLInputElement>();
  let drafts = $state<Record<string, string>>({});
  let transcript: HTMLDivElement;
  let requestNumber = 0;
  const selected = $derived(workspace?.selected);
  const active = $derived(workspace?.activeConversationId);

  async function load() {
    const number = ++requestNumber;
    try {
      const next = await window.athena.workspace();
      if (number === requestNumber) workspace = next;
    } catch { error = 'Could not load conversations. Restart Athena to try again.'; }
  }

  async function change(action: () => Promise<Workspace>): Promise<boolean> {
    busy = true;
    error = '';
    const number = ++requestNumber;
    try {
      const next = await action();
      if (number === requestNumber) workspace = next;
      return true;
    } catch {
      error = 'Could not save this change. Your draft is still here. Try again.';
      return false;
    } finally { busy = false; }
  }

  async function newConversation() {
    naming = true;
    await tick();
    nameInput?.focus();
  }
  async function create() {
    if (!title.trim() || busy) return;
    if (await change(() => window.athena.create(title))) {
      title = '';
      naming = false;
    }
  }
  async function send() {
    if (!selected || busy || active) return;
    const id = selected.id;
    const text = drafts[id] ?? '';
    if (!text.trim()) return;
    if (await change(() => window.athena.send(id, text))) drafts[id] = '';
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
    <div class="sidebar-heading">Your conversations</div>
    <button class="new-conversation" onclick={newConversation} disabled={busy || !workspace}><span aria-hidden="true">+</span> New conversation</button>
    {#if naming}
      <form class="name-form" onsubmit={(event) => { event.preventDefault(); void create(); }}>
        <label for="name">Conversation name</label>
        <input id="name" bind:this={nameInput} bind:value={title} maxlength={MAX_TITLE_LENGTH} required placeholder="An investigation to return to" />
        <div class="form-actions">
          <button class="primary" disabled={busy || !title.trim()}>Create conversation</button>
          <button type="button" onclick={() => naming = false}>Cancel</button>
        </div>
      </form>
    {/if}
    <nav aria-label="Saved conversations">
      {#each workspace?.conversations ?? [] as conversation (conversation.id)}
        <button class:selected={selected?.id === conversation.id}
          aria-current={selected?.id === conversation.id ? 'page' : undefined}
          disabled={busy} onclick={() => change(() => window.athena.select(conversation.id))}>
          <span class="conversation-icon" aria-hidden="true">↳</span>
          <span>{conversation.title}</span>
          {#if active === conversation.id}<span class="running-dot" aria-label={workspace?.saveError ? 'Not saved' : 'Running'}></span>{/if}
        </button>
      {/each}
    </nav>
    <div class="local-note"><span class="eyebrow">On this Mac</span><p>Conversations stay here.<br />Close Athena. Pick up later.</p></div>
  </aside>

  <main>
    <header>
      <div><div class="eyebrow">Conversation workspace</div><h1>{selected?.title ?? 'A place to investigate'}</h1></div>
      <span class="demo-badge">Local demo</span>
    </header>
    {#if error || workspace?.saveError}<div class="error" role="alert">{error || workspace?.saveError}</div>{/if}
    <div class="transcript" bind:this={transcript} role="log" aria-label="Messages" aria-live="polite">
      {#if !workspace}
        <p class="empty-copy">Loading your conversations…</p>
      {:else if !selected || selected.messages.length === 0}
        <section class="welcome">
          <span class="eyebrow">Start with a question</span>
          <h2>A thread worth<br />coming back to.</h2>
          <p>This first version keeps your conversations on your Mac. Send a message to try a deterministic response, then reopen Athena to find it here.</p>
          <div class="capabilities" aria-label="Demonstration permissions">
            <div><span>Repositories</span><strong>Not accessed</strong></div>
            <div><span>Model calls</span><strong>None</strong></div>
            <div><span>Storage</span><strong>Local only</strong></div>
          </div>
          {#if !selected}<button class="primary" onclick={newConversation}>Create your first conversation</button>{/if}
        </section>
      {:else}
        {#each selected.messages as message (message.id)}
          <article class:user={message.role === 'user'} class="message">
            <div class="message-heading"><strong>{message.role === 'user' ? 'You' : 'Athena'}</strong>
              {#if message.role === 'assistant'}<span class:problem={message.status === 'failed' || message.status === 'cancelled'}>{message.status === 'running' && workspace?.saveError ? 'Not saved' : message.status === 'complete' ? 'Local demo' : message.status}</span>{/if}
            </div>
            <p>{message.text}</p>
          </article>
        {/each}
      {/if}
    </div>
    {#if selected}
      <form class="composer" onsubmit={(event) => { event.preventDefault(); void send(); }}>
        <label for="message">Message</label>
        <textarea id="message" bind:value={drafts[selected.id]} maxlength={MAX_MESSAGE_LENGTH} rows="3"
          disabled={busy} placeholder="Ask a question to try the local demo…"
          onkeydown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }}></textarea>
        <div class="composer-actions">
          <span>{workspace?.saveError ? 'Demonstration stopped · Result not saved' : active ? 'Demonstration running. No paid work.' : 'Saved locally · No repository access · No model charges'}</span>
          {#if active}
            <button type="button" disabled={busy} onclick={() => change(() => window.athena.cancel())}>{workspace?.saveError ? 'Retry saving' : 'Stop demonstration'}</button>
          {:else}
            <button class="primary" aria-label="Send message" disabled={busy || !(drafts[selected.id] ?? '').trim()}>Send <span aria-hidden="true">↗</span></button>
          {/if}
        </div>
      </form>
    {/if}
  </main>
</div>
