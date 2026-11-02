import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, renameSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inventory } from '../../src/main/inventory';
import { Sources } from '../../src/main/sources';
import { Knowledge } from '../../src/main/knowledge';
import { Conversations } from '../../src/main/conversations';
import { Resolutions } from '../../src/main/resolutions';
import { FolderAccess } from '../../src/main/folder-access';
import { FOLDER_CONSENT, PURGE_CONFIRMATION } from '../../src/shared/inventory';
import type { Evidence, LiveResult } from '../../src/shared/live';

vi.mock('node:fs/promises', { spy: true });

let directory: string, left: string, right: string;
let inventory: Inventory, sources: Sources, knowledge: Knowledge, conversations: Conversations, resolutions: Resolutions, access: FolderAccess;
let stopped: boolean;
const binding = { model: 'fixture', registration: 'fixture' };
const result: LiveResult = { status: 'complete', text: 'Private cached answer [E1]', history: [{ role: 'user', content: 'Private cached protocol', timestamp: 0 }], requests: 1, usageComplete: true };
const candidate = (scope: string, relations: { kind: 'depends-on'; target: string }[] = []) => ({ id: 'C1', scope, topic: 'Shared assertion', summary: 'A shared boundary.', kind: 'responsibility', claim: 'This boundary serves requests.', provenance: 'statically-inferred', perspective: 'current', evidenceIds: ['E1'], relations });
function open() {
  inventory = new Inventory(join(directory, 'inventory.sqlite'));
  conversations = new Conversations(join(directory, 'conversations.sqlite'), () => inventory.snapshot().roots.filter(root => root.revokedAt).map(root => root.path));
  sources = new Sources(join(directory, 'sources.sqlite'), inventory);
  knowledge = new Knowledge(join(directory, 'knowledge.sqlite'), sources, inventory, () => {});
  resolutions = new Resolutions(join(directory, 'resolutions.sqlite'), knowledge, () => {}, () => {});
  access = new FolderAccess(inventory, conversations, sources, knowledge, resolutions, () => { stopped = true; });
}
function close() { resolutions.close(); knowledge.close(); sources.close(); conversations.close(); inventory.close(); }
async function evidence(root: string): Promise<Evidence[]> {
  const entry = (await sources.run('read', { root, path: 'source.ts', start: 1, end: 1 })).entries[0];
  return [{ id: 'E1', citation: entry.citation!, text: entry.text! }];
}
async function publish(root: string, relations: { kind: 'depends-on'; target: string }[] = []) {
  const observed = await evidence(root);
  return knowledge.publish({ owner: { conversationId: 'conversation', messageId: root }, evidence: observed, candidates: [{ ...candidate(root === left ? 'left' : 'right', relations), ...(relations.length ? { topic: 'Dependent assertion', claim: 'This conclusion requires the private boundary.' } : {}) }], completed: true, environmentExposed: false, signal: new AbortController().signal });
}
beforeEach(async () => {
  vi.mocked(fs.open).mockImplementation((await vi.importActual<typeof fs>('node:fs/promises')).open);
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-folder-access-')));
  left = join(directory, 'left'); right = join(directory, 'right');
  for (const root of [left, right]) { mkdirSync(join(root, '.git'), { recursive: true }); writeFileSync(join(root, 'source.ts'), 'export const serve = true;'); }
  stopped = false; open();
  await inventory.designate(left, FOLDER_CONSENT); await inventory.designate(right, FOLDER_CONSENT); await inventory.scan();
});
afterEach(() => { vi.restoreAllMocks(); close(); rmSync(directory, { recursive: true, force: true }); });

test.each(['serialized-knowledge', 'compacted-knowledge'] as const)('legacy %s history cannot escape withdrawal labels, context filtering or purge', async encoding => {
  const observed = await evidence(left);
  const history: LiveResult['history'] = encoding === 'serialized-knowledge'
    ? [{ role: 'toolResult', toolCallId: 'lookup', toolName: 'retrieve_knowledge', timestamp: 0, isError: false, content: [{ type: 'text', text: JSON.stringify({ items: [{ claim: 'Private lead', evidence: [{ citation: observed[0].citation }] }] }) }] }]
    : [{ role: 'user', timestamp: 0, content: 'Private compacted interpretation; source envelopes were discarded.' }];
  // Pre-#19 attempts have no root catalogue and may never have acquired E evidence.
  const job = conversations.beginLive(null, 'Legacy knowledge question', binding);
  conversations.finishLive(job.messageId, { ...result, history, ...(encoding === 'compacted-knowledge' ? { knowledgeReferences: [{ id: 'K' + 'a'.repeat(64), topic: 'Private lead' }] } : {}) }, []);
  access.revoke(left);
  expect(conversations.workspace().selected?.revokedSources).toEqual([left]);
  expect(conversations.resumeContext(job.conversationId).history).toEqual([]);
  await access.purge(left, PURGE_CONFIRMATION);
  expect(conversations.workspace().conversations).toEqual([]);
});

test('fresh support at a reconnected independently authorized location survives withdrawal and purge of the original grant', async () => {
  const [original] = await publish(left);
  const moved = join(right, 'relocated'); renameSync(left, moved);
  await inventory.scan(); inventory.reconnect('left', moved);
  const entry = (await sources.run('read', { root: right, path: 'relocated/source.ts', start: 1, end: 1 })).entries[0];
  const [fresh] = await knowledge.publish({ owner: { conversationId: 'fresh', messageId: 'fresh' }, evidence: [{ id: 'E1', citation: entry.citation!, text: entry.text! }], candidates: [candidate('left')], completed: true, environmentExposed: false, signal: new AbortController().signal });
  expect(fresh).not.toBe(original);
  access.revoke(left);
  expect((await knowledge.retrieve({ operation: 'evidence', id: fresh, index: 0 })).evidence?.citation.folder).toBe(right);
  await access.purge(left, PURGE_CONFIRMATION);
  expect((await knowledge.inspect()).map(record => record.id)).toEqual([fresh]);
});

test('withdrawal filters cached excerpts, history, annotations and dependent assertions but preserves independently supported shared knowledge', async () => {
  const [privateId] = await publish(left);
  const [independentId] = await publish(right);
  const [dependentId] = await publish(right, [{ kind: 'depends-on', target: privateId }]);
  const annotation = (await resolutions.write({ operation: 'annotate', kind: 'note', text: 'Private annotation', claimIds: [dependentId] })).items[0];
  const observed = await evidence(left);
  const job = conversations.beginLive(null, 'Private question', binding);
  conversations.finishLive(job.messageId, result, observed);
  // A later source-free turn must not launder the original conversation.
  const next = conversations.beginLive(job.conversationId, 'Continue', binding);
  conversations.finishLive(next.messageId, result, []);
  access.revoke(left);
  expect(stopped).toBe(true);
  for (const id of [privateId, dependentId]) expect((await knowledge.retrieve({ operation: 'detail', id })).items).toEqual([]);
  expect((await knowledge.inspect()).map(record => record.id)).toEqual([independentId]);
  expect((await knowledge.retrieve({ operation: 'evidence', id: independentId, index: 0 })).evidence?.text).toBe('export const serve = true;');
  expect((await resolutions.read({ operation: 'inspect', id: annotation.id })).items).toEqual([]);
  expect(conversations.workspace().selected).toMatchObject({ revokedSources: [left], messages: [{ text: 'Private question' }, { text: result.text }, { text: 'Continue' }, { text: result.text }] });
  expect(conversations.resumeContext(job.conversationId).history).toEqual([]);
  expect(conversations.liveContext(job.conversationId).history).toEqual([]);
  expect(conversations.naming(job.conversationId)).toEqual({ needsTitle: false });
  close(); open(); await access.recover();
  expect(conversations.workspace().selected?.revokedSources).toEqual([left]);
  expect((await knowledge.retrieve({ operation: 'detail', id: privateId })).items).toEqual([]);
  expect(() => conversations.beginLive(job.conversationId, '', binding, next.messageId)).toThrow();
});

test('explicit purge removes whole owned conversations, annotations and dependent contributions and late results cannot recreate them', async () => {
  const [privateId] = await publish(left); const [independentId] = await publish(right);
  const [dependentId] = await publish(right, [{ kind: 'depends-on', target: privateId }]);
  await resolutions.write({ operation: 'annotate', kind: 'note', text: 'Private annotation', claimIds: [dependentId] });
  const observed = await evidence(left);
  const job = conversations.beginLive(null, 'Private question', binding);
  conversations.finishLive(job.messageId, result, observed);
  const other = conversations.beginLive(null, 'Unrelated question', binding); conversations.finishLive(other.messageId, { ...result, text: 'Unrelated answer' }, []);
  expect(() => access.purge(left, 'yes')).toThrow(/confirmation/);
  expect(inventory.snapshot().roots[0].revokedAt).toBeUndefined();
  await access.purge(left, PURGE_CONFIRMATION);
  conversations.finishLive(job.messageId, result, observed);
  conversations.progressInvestigators(job.messageId, [], observed);
  expect(conversations.workspace().conversations.map(item => item.id)).toEqual([other.conversationId]);
  expect((await knowledge.inspect()).map(record => record.id)).toEqual([independentId]);
  expect((await resolutions.read({ operation: 'list' })).items).toEqual([]);
  expect(inventory.snapshot().roots[0]).toMatchObject({ purgePending: false, purgedAt: expect.any(String) });
  await expect(knowledge.publish({ owner: { conversationId: job.conversationId, messageId: job.messageId }, evidence: observed, candidates: [candidate('left')], completed: true, environmentExposed: false, signal: new AbortController().signal })).rejects.toThrow(/revoked/);
  close(); open(); await access.recover();
  expect((await knowledge.inspect()).map(record => record.id)).toEqual([independentId]);
});

test('a failed destructive database step leaves a durable pending purge that restart completes', async () => {
  const [id] = await publish(left);
  await resolutions.write({ operation: 'annotate', kind: 'note', text: 'Private annotation', claimIds: [id] });
  const job = conversations.beginLive(null, 'Private question', binding, undefined, undefined, [left]);
  conversations.finishLive(job.messageId, result, []);
  const blocker = new DatabaseSync(join(directory, 'resolutions.sqlite'));
  blocker.exec('BEGIN IMMEDIATE');
  try { await expect(access.purge(left, PURGE_CONFIRMATION)).rejects.toThrow(/locked/); }
  finally { blocker.exec('ROLLBACK'); blocker.close(); }
  expect(inventory.snapshot().roots[0]).toMatchObject({ revokedAt: expect.any(String), purgePending: true });
  close(); open(); await access.recover();
  expect(conversations.workspace().conversations).toEqual([]);
  expect(await knowledge.inspect()).toEqual([]);
  expect((await resolutions.read({ operation: 'list' })).items).toEqual([]);
  expect(inventory.snapshot().roots[0].purgePending).toBe(false);
});

test.each(['current', 'reconnected-origin'] as const)('annotation inspection rechecks every %s target after sequential IO', async revision => {
  const [leftId] = await publish(left), [rightId] = await publish(right);
  const annotation = (await resolutions.write({ operation: 'annotate', kind: 'note', text: 'Explanation derived from both folders', claimIds: [leftId, rightId] })).items[0];
  if (revision === 'reconnected-origin') await resolutions.write({ operation: 'reconnect', id: annotation.id, claimIds: [rightId] });
  const actual = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  let entered!: () => void, resume!: () => void, paused = false;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual(...args);
    if (!paused && String(args[0]) === join(right, 'source.ts')) { paused = true; entered(); await released; }
    return handle;
  });
  const inspection = resolutions.read({ operation: 'inspect', id: annotation.id });
  await waiting; access.revoke(left); resume();
  expect((await inspection).items).toEqual([]);
});

test('withdrawal during retrieval IO never returns a cached excerpt or claim', async () => {
  const [id] = await publish(left);
  const actual = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual(...args);
    if (String(args[0]) === join(left, 'source.ts')) access.revoke(left);
    return handle;
  });
  const found = await knowledge.retrieve({ operation: 'evidence', id, index: 0 });
  expect(stopped).toBe(true);
  expect(found.items).toEqual([]);
  expect(found.evidence).toBeUndefined();
});

test('restart replays a purge interrupted between databases without reopening access', async () => {
  await publish(left); await publish(right);
  const job = conversations.beginLive(null, 'Private question', binding, undefined, undefined, [left]);
  conversations.finishLive(job.messageId, result, []);
  access.revoke(left); inventory.purgeState([left], true);
  // Simulate a crash after just the first destructive step committed.
  await resolutions.purge([left]);
  close(); open();
  expect(inventory.snapshot().roots[0].purgePending).toBe(true);
  await access.recover();
  expect(conversations.workspace().conversations).toEqual([]);
  expect((await knowledge.inspect()).map(record => record.scope)).toEqual(['right']);
  await expect(sources.run('read', { root: left, path: 'source.ts' })).rejects.toThrow(/permission/);
  expect(inventory.snapshot().roots[0].purgePending).toBe(false);
});

test('revocation at the publication commit guard rolls back an already-written batch', async () => {
  const observed = await evidence(left);
  let guards = 0;
  const pending = knowledge.publish({ owner: { conversationId: 'c', messageId: 'm' }, evidence: observed, candidates: [candidate('left')], completed: true, environmentExposed: false, signal: new AbortController().signal,
    assertPublishable: () => { if (++guards === 3) access.revoke(left); } });
  await expect(pending).rejects.toThrow(/revoked/);
  await access.purge(left, PURGE_CONFIRMATION);
  expect(await knowledge.inspect()).toEqual([]);
});

test('revocation while normalization is awaiting IO cannot commit even without cooperative cancellation', async () => {
  const observed = await evidence(left);
  const pending = knowledge.publish({ owner: { conversationId: 'c', messageId: 'm' }, evidence: observed, candidates: [candidate('left')], completed: true, environmentExposed: false, signal: new AbortController().signal });
  access.revoke(left);
  await expect(pending).rejects.toThrow(/revoked/);
  expect(await knowledge.inspect()).toEqual([]);
});
