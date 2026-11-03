import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Knowledge } from '../../src/main/knowledge';
import { Resolutions } from '../../src/main/resolutions';
import { Sources } from '../../src/main/sources';
import { DatabaseSync } from 'node:sqlite';
import { ResolutionGateway } from '../../src/main/resolution-bridge';
import { MaintenanceGateway } from '../../src/main/maintenance-bridge';
import { RESET_CONFIRMATION } from '../../src/shared/maintenance';
import { Conversations } from '../../src/main/conversations';
import { FOLDER_CONSENT, folderGranted, type InventorySnapshot } from '../../src/shared/inventory';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); });
async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-resolutions-')));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo'); mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'Use dependency B.\n');
  writeFileSync(join(root, 'service.ts'), 'export const result = C.call();\n');
  const snapshot: InventorySnapshot = { roots: [{ path: root, consent: FOLDER_CONSENT, acceptedAt: 'now', includedLocations: [] }], repositories: [{ name: 'service', path: root, presence: 'present', documentationRoots: [], boundaries: [], fileCount: 2, examined: false }], candidates: [], discovery: { status: 'complete', visited: 0, current: '', nonGitFiles: 0, failures: [] } };
  const inventory = { snapshot: () => structuredClone(snapshot), granted: (path: string) => folderGranted(snapshot.roots, path) };
  const conversations = new Conversations(join(directory, 'conversations.sqlite')); cleanup.push(() => conversations.close());
  const sources = new Sources(':memory:', inventory); cleanup.push(() => sources.close());
  const knowledge = new Knowledge(join(directory, 'knowledge.sqlite'), sources, inventory, value => conversations.assertClean(value)); cleanup.push(() => knowledge.close());
  let writable = true;
  const path = join(directory, 'resolutions.sqlite');
  const open = () => new Resolutions(path, knowledge, value => conversations.assertClean(value), () => { if (!writable) throw new Error('Clean idle context required.'); });
  const resolutions = open(); cleanup.push(() => resolutions.close());
  const publish = async (location = root, scope = 'service', dependency?: string) => {
    const evidence = await Promise.all(['README.md', 'service.ts'].map(async (path, index) => {
      const result = await sources.run('read', { root: location, path, start: 1, end: 1 });
      return { id: `E${index + 1}`, citation: result.entries[0].citation!, text: result.entries[0].text! };
    }));
    return knowledge.publish({ owner: { conversationId: 'conversation', messageId: 'message' }, candidates: [
      { id: 'C1', scope, topic: 'Dependency', summary: 'Declared dependency.', kind: 'decision', claim: 'Use dependency B.', provenance: 'declared', perspective: 'intended', evidenceIds: ['E1'], relations: [{ kind: 'conflicts-with', target: 'C2' }, ...(dependency ? [{ kind: 'depends-on', target: dependency }] : [])] },
      { id: 'C2', scope, topic: 'Dependency', summary: 'Implementation dependency.', kind: 'behavior', claim: 'The implementation calls C.', provenance: 'statically-inferred', perspective: 'current', evidenceIds: ['E2'], relations: [] },
    ], evidence, completed: true, environmentExposed: false, signal: new AbortController().signal });
  };
  return { directory, root, knowledge, resolutions, publish, conversations, snapshot, open, setWritable: (value: boolean) => { writable = value; } };
}

test('authorized local reset preserves durable user state and annotations without relinking even identical extracted IDs', async () => {
  const f = await fixture(); const ids = await f.publish();
  const annotation = (await f.resolutions.write({ operation: 'annotate', kind: 'intent', text: 'C is intentional.', claimIds: ids })).items[0];
  const demo = f.conversations.begin(null, 'Durable question'); f.conversations.finish(demo.messageId, 'complete', 'Durable answer');
  f.conversations.setMaxInvestigators(2); f.conversations.setVerboseDays(45);
  const before = f.conversations.workspace(); const folders = structuredClone(f.snapshot);
  const owner = { webContentsId: 1, url: 'file:///athena/index.html' }; const caller = { ...owner, isMainFrame: true };
  let idle = false;
  const maintenance = new MaintenanceGateway(f.conversations, f.knowledge, owner, () => idle);
  await expect(maintenance.dispatch(caller, 'reset', { confirmation: RESET_CONFIRMATION })).rejects.toThrow(/active/i);
  idle = true;
  for (const invalid of [{ ...caller, isMainFrame: false }, { ...caller, webContentsId: 2 }, { ...caller, url: 'https://other.test' }]) {
    await expect(maintenance.dispatch(invalid, 'reset', { confirmation: RESET_CONFIRMATION })).rejects.toThrow(/Unauthorized/i);
  }
  await expect(maintenance.dispatch(caller, 'reset', { confirmation: 'yes' })).rejects.toThrow();
  await expect(maintenance.dispatch(caller, 'policy', { verboseDays: '0' })).rejects.toThrow();
  const pending = maintenance.dispatch(caller, 'reset', { confirmation: RESET_CONFIRMATION });
  expect(maintenance.busy).toBe(true);
  await expect(maintenance.dispatch(caller, 'cleanup', undefined)).rejects.toThrow();
  await pending;
  expect(f.conversations.workspace()).toEqual(before); expect(f.snapshot).toEqual(folders);
  expect(f.conversations.retentionStatus().verboseDays).toBe(45);
  expect((await f.knowledge.retrieve({ operation: 'search', query: '' })).items).toEqual([]);
  expect((await f.resolutions.read({ operation: 'list' })).items[0]).toMatchObject({ id: annotation.id, status: 'requires-reconnection' });
  const replacements = await f.publish(); expect(replacements).toEqual(ids);
  expect((await f.resolutions.read({ operation: 'list', claimId: replacements[0] })).items).toEqual([]);
  expect((await f.resolutions.write({ operation: 'reconnect', id: annotation.id, claimIds: replacements })).items[0].status).toBe('recorded-for-these-versions');
});

test('deleted evidence leaves a content-withheld reconciliation entry without exposing revoked material or authorizing unsafe reconnection', async () => {
  const f = await fixture(); const ids = await f.publish();
  const annotation = (await f.resolutions.write({ operation: 'annotate', kind: 'intent', text: 'Private retained explanation.', claimIds: ids })).items[0];
  await f.knowledge.clear(); rmSync(join(f.root, 'service.ts'));
  const orphan = (await f.resolutions.read({ operation: 'list' })).items[0];
  expect(orphan).toMatchObject({ id: annotation.id, status: 'requires-reconsideration', unavailable: true, bindings: [], versions: [] });
  expect(JSON.stringify(orphan)).not.toContain('Private retained explanation');
  expect(JSON.stringify(orphan)).not.toContain('C.call');
  expect((await f.resolutions.read({ operation: 'inspect', id: annotation.id })).items[0].id).toBe(annotation.id);
  expect((await f.resolutions.read({ operation: 'list' }, undefined, false)).items).toEqual([]); // No model attachment fallback.
  const other = otherSource(f); const unrelated = await f.publish(other, 'other');
  await expect(f.resolutions.write({ operation: 'reconnect', id: annotation.id, claimIds: unrelated })).rejects.toThrow();
  const roots = f.snapshot.roots; f.snapshot.roots = [roots[1]];
  expect((await f.resolutions.read({ operation: 'list' })).items).toEqual([]);
  f.snapshot.roots = [{ ...roots[0], revokedAt: 'now' }, roots[1]];
  expect((await f.resolutions.read({ operation: 'list' })).items).toEqual([]);
  f.snapshot.roots = roots; writeFileSync(join(f.root, 'service.ts'), 'export const result = C.call();\n');
  expect((await f.resolutions.read({ operation: 'list' })).items[0]).toMatchObject({ id: annotation.id, text: annotation.text, status: 'requires-reconsideration' });
  const replacements = await f.publish();
  expect((await f.resolutions.write({ operation: 'reconnect', id: annotation.id, claimIds: replacements })).items[0].revision).toBe(2);
});

test('user resolutions bind both evidence versions, survive derived replacement, and reconnect only by explicit confirmation', async () => {
  const f = await fixture();
  const ids = await f.publish();
  const saved = (await f.resolutions.write({ operation: 'annotate', kind: 'obsolete-declaration', text: 'B was an early plan; keep C.', claimIds: ids })).items[0];
  expect(saved).toMatchObject({ author: 'user', revision: 1, status: 'recorded-for-these-versions', bindings: [{ claim: 'Use dependency B.' }, { claim: 'The implementation calls C.' }] });
  expect((await f.resolutions.read({ operation: 'list', claimId: ids[1] })).items[0].id).toBe(saved.id);
  expect((await f.knowledge.retrieve({ operation: 'detail', id: ids[0] })).items[0].validation).toBe('conflicting');
  await f.knowledge.clear();
  const replacements = await f.publish();
  expect(replacements).toEqual(ids); // Even identical content-derived IDs cannot rebind a rebuilt ledger.
  expect((await f.resolutions.read({ operation: 'list', claimId: replacements[0] })).items).toEqual([]);
  expect((await f.resolutions.read({ operation: 'list' })).items[0].status).toBe('requires-reconnection');
  const reopened = f.open(); cleanup.push(() => reopened.close());
  const rebound = (await reopened.write({ operation: 'reconnect', id: saved.id, claimIds: replacements })).items[0];
  expect(rebound).toMatchObject({ id: saved.id, revision: 2, status: 'recorded-for-these-versions' });
  expect((await reopened.read({ operation: 'inspect', id: saved.id, revision: 1 })).items[0].status).toBe('requires-reconnection');
  writeFileSync(join(f.root, 'service.ts'), 'export const result = D.call();\n');
  expect((await reopened.read({ operation: 'list', claimId: replacements[1] })).items[0].status).toBe('requires-reconsideration');
  expect((await f.knowledge.retrieve({ operation: 'detail', id: replacements[0] })).items[0].conflicts[0].claim).toBe('The implementation calls C.');
  const newer = await f.publish();
  await reopened.write({ operation: 'reconnect', id: saved.id, claimIds: newer });
  expect((await reopened.read({ operation: 'list', claimId: newer[0] })).items[0].revision).toBe(3);
  expect((await reopened.read({ operation: 'list', claimId: replacements[0] })).items[0]).toMatchObject({ revision: 2, status: 'requires-reconsideration' });
  expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('Use dependency B.\n');
});

function otherSource(f: Awaited<ReturnType<typeof fixture>>) {
  const location = join(f.directory, 'other'); mkdirSync(join(location, '.git'), { recursive: true });
  writeFileSync(join(location, 'README.md'), 'Use dependency B.\n');
  writeFileSync(join(location, 'service.ts'), 'export const result = C.call();\n');
  f.snapshot.roots.push({ ...f.snapshot.roots[0], path: location });
  f.snapshot.repositories.push({ ...f.snapshot.repositories[0], name: 'other', path: location });
  return location;
}

test('reconnection cannot launder revoked annotation text onto accessible claims, even after an earlier authorized reconnection', async () => {
  const f = await fixture(); const ids = await f.publish();
  const saved = (await f.resolutions.write({ operation: 'annotate', kind: 'note', text: 'Private source A explanation.', claimIds: ids })).items[0];
  const other = otherSource(f); const replacements = await f.publish(other, 'other');
  const roots = [...f.snapshot.roots]; f.snapshot.roots = [roots[1]];
  expect((await f.resolutions.read({ operation: 'inspect', id: saved.id })).items).toEqual([]);
  await expect(f.resolutions.write({ operation: 'reconnect', id: saved.id, claimIds: replacements })).rejects.toThrow();
  f.snapshot.roots = roots;
  expect((await f.resolutions.read({ operation: 'inspect', id: saved.id })).items[0].revision).toBe(1);
  await f.resolutions.write({ operation: 'reconnect', id: saved.id, claimIds: replacements });
  f.snapshot.roots = [roots[1]];
  expect((await f.resolutions.read({ operation: 'list', claimId: replacements[0] })).items).toEqual([]);
  expect((await f.resolutions.attach(await f.knowledge.retrieve({ operation: 'detail', id: replacements[0] }))).items[0].annotations).toBeUndefined();
});

test('adding transitive evidence to an unchanged claim identity requires reconsideration before an ordinary claim read', async () => {
  const f = await fixture(); const ids = await f.publish();
  const other = otherSource(f); const dependencies = await f.publish(other, 'other');
  const saved = (await f.resolutions.write({ operation: 'annotate', kind: 'intent', text: 'Intent for the original evidence versions.', claimIds: [ids[0]] })).items[0];
  const republished = await f.publish(f.root, 'service', dependencies[0]);
  expect(republished[0]).toBe(ids[0]);
  expect((await f.resolutions.read({ operation: 'inspect', id: saved.id })).items[0].status).toBe('requires-reconsideration');
  writeFileSync(join(other, 'service.ts'), 'export const result = D.call();\n');
  expect((await f.resolutions.read({ operation: 'inspect', id: saved.id })).items[0].status).toBe('requires-reconsideration');
  f.snapshot.roots = [f.snapshot.roots[0]];
  expect((await f.resolutions.read({ operation: 'inspect', id: saved.id })).items).toEqual([]);
});

test('annotation attachments share the original response-wide graph budget, including transitive claims and original provenance', async () => {
  const f = await fixture(); const base = await f.publish();
  const other = otherSource(f); const original = await f.publish(other, 'other');
  const saved = (await f.resolutions.write({ operation: 'annotate', kind: 'note', text: 'Assertion with separately authorized original provenance.', claimIds: [original[0]] })).items[0];
  const { record } = await f.knowledge.resolutionTarget(base[0], new AbortController().signal);
  let head: string | undefined;
  const extend = async (index: number) => {
    [head] = await f.knowledge.publish({ owner: { conversationId: 'chain', messageId: `chain-${index}` }, candidates: [{
      id: 'C1', scope: 'service', topic: 'Chain', summary: `Chain assertion ${index}.`, claim: `Chain assertion ${index}.`, kind: 'behavior',
      provenance: 'statically-inferred', perspective: 'current', evidenceIds: ['E1'], relations: head ? [{ kind: 'depends-on', target: head }] : [],
    }], evidence: record.evidence, completed: true, environmentExposed: false, signal: new AbortController().signal });
    return head!;
  };
  for (let index = 1; index <= 31; index++) await extend(index);
  const annotated = head!;
  await f.resolutions.write({ operation: 'reconnect', id: saved.id, claimIds: [annotated] });
  expect((await f.resolutions.read({ operation: 'list', claimId: annotated })).items).toHaveLength(1); // 31 transitive claims + original = 32.
  const outer = await extend(32);
  await expect(f.resolutions.write({ operation: 'reconnect', id: saved.id, claimIds: [outer] })).rejects.toThrow();
  expect((await f.resolutions.read({ operation: 'inspect', id: saved.id })).items[0].revision).toBe(2);
  const response = await f.knowledge.retrieve({ operation: 'expand', id: outer, kinds: ['depends-on'] });
  expect(response.items[0].id).toBe(annotated); // The original retrieval has already checked 32 claims.
  expect((await f.resolutions.attach(response)).items[0].annotations).toBeUndefined(); // The separate origin would be claim 33.
});

test('orphaned annotations remain inspectable after source changes, withhold revoked sources, and explicitly reconnect to re-extracted versions', async () => {
  const f = await fixture(); const ids = await f.publish();
  const saved = (await f.resolutions.write({ operation: 'annotate', kind: 'note', text: 'My explanation for this discrepancy.', claimIds: ids })).items[0];
  await f.knowledge.clear();
  writeFileSync(join(f.root, 'service.ts'), 'export const result = D.call();\n');
  expect((await f.resolutions.read({ operation: 'inspect', id: saved.id })).items[0]).toMatchObject({ revision: 1, status: 'requires-reconsideration' });
  const roots = f.snapshot.roots; f.snapshot.roots = [];
  expect((await f.resolutions.read({ operation: 'list' })).items).toEqual([]);
  f.snapshot.roots = roots;
  const replacements = await f.publish();
  expect((await f.resolutions.read({ operation: 'list', claimId: replacements[0] })).items).toEqual([]);
  expect((await f.resolutions.write({ operation: 'reconnect', id: saved.id, claimIds: replacements })).items[0]).toMatchObject({ revision: 2, status: 'recorded-for-these-versions' });
  expect((await f.resolutions.read({ operation: 'inspect', id: saved.id, revision: 1 })).items[0].status).toBe('requires-reconsideration');
});

test('source-change reconsideration is sticky, while model reads do not persist observations', async () => {
  const f = await fixture(); const ids = await f.publish();
  const annotation = (await f.resolutions.write({ operation: 'annotate', kind: 'note', text: 'No B path found in this bounded inspection; not proof of absence.', claimIds: ids })).items[0];
  writeFileSync(join(f.root, 'service.ts'), 'export const result = D.call();\n');
  const unobserved = await f.knowledge.retrieve({ operation: 'detail', id: ids[0] }, undefined, { persistInvalidations: false });
  expect((await f.resolutions.attach(unobserved)).items[0].annotations?.[0].status).toBe('requires-reconsideration');
  writeFileSync(join(f.root, 'service.ts'), 'export const result = C.call();\n');
  expect((await f.resolutions.read({ operation: 'inspect', id: annotation.id })).items[0].status).toBe('recorded-for-these-versions');
  writeFileSync(join(f.root, 'service.ts'), 'export const result = D.call();\n');
  expect((await f.resolutions.read({ operation: 'list' })).items[0].status).toBe('requires-reconsideration');
  writeFileSync(join(f.root, 'service.ts'), 'export const result = C.call();\n');
  expect((await f.resolutions.read({ operation: 'list' })).items[0].status).toBe('requires-reconsideration');
});

test('only the authorized main-frame user gateway can write bounded annotations and failures roll back the revision', async () => {
  const f = await fixture(); const ids = await f.publish();
  const owner = { webContentsId: 1, url: 'file:///athena/index.html' };
  const caller = { ...owner, isMainFrame: true };
  const gateway = new ResolutionGateway(f.resolutions, owner);
  const payload = { operation: 'annotate', kind: 'note', text: 'A user discrepancy note.', claimIds: ids };
  for (const invalid of [{ ...caller, isMainFrame: false }, { ...caller, webContentsId: 2 }, { ...caller, url: 'https://other.test/' }]) expect(() => gateway.dispatch(invalid, 'write', payload)).toThrow();
  await expect(gateway.dispatch(caller, 'write', { ...payload, environmentExposed: false })).rejects.toThrow();
  const first = (await gateway.dispatch(caller, 'write', payload)).items[0];
  const fault = new DatabaseSync(join(f.directory, 'resolutions.sqlite'));
  try {
    fault.exec("CREATE TRIGGER annotation_fault BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    await expect(gateway.dispatch(caller, 'write', { operation: 'reconnect', id: first.id, claimIds: ids })).rejects.toThrow();
    expect((await f.resolutions.read({ operation: 'inspect', id: first.id })).items[0].revision).toBe(1);
  } finally { fault.close(); }
});

test('annotations are assertions in bounded model retrieval, never source citations or semantic verification', async () => {
  const f = await fixture(); const ids = await f.publish();
  await f.resolutions.write({ operation: 'annotate', kind: 'intent', text: 'Eventually use B, but C is intentional today.', claimIds: ids });
  const result = await f.resolutions.attach(await f.knowledge.retrieve({ operation: 'detail', id: ids[1] }));
  expect(result.items[0]).toMatchObject({ provenance: 'statically-inferred', validation: 'conflicting', annotations: [{ author: 'user', kind: 'intent', text: 'Eventually use B, but C is intentional today.' }] });
  expect(result.evidence).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24 * 1024);
  const roots = f.snapshot.roots; f.snapshot.roots = [];
  expect((await f.resolutions.read({ operation: 'list' })).items).toEqual([]);
  f.snapshot.roots = roots;
  expect((await f.resolutions.read({ operation: 'list' })).items).toHaveLength(1);
});

test('unknown or tainted material and non-idle contexts cannot create or reconnect annotations, including queued writes', async () => {
  const f = await fixture(); const ids = await f.publish();
  const canary = 'private-environment-canary-92846'; f.conversations.rememberEnvironment('PRIVATE_CONTEXT=' + canary);
  for (const text of [canary, 'The intent was API_KEY=actual-private-value-92846']) {
    await expect(f.resolutions.write({ operation: 'annotate', kind: 'note', text, claimIds: ids })).rejects.toThrow();
  }
  await expect(f.resolutions.write({ operation: 'annotate', kind: 'note', text: 'Safe assertion.', claimIds: ['K' + 'a'.repeat(64)] })).rejects.toThrow();
  f.setWritable(false);
  await expect(f.resolutions.write({ operation: 'annotate', kind: 'note', text: 'Safe assertion.', claimIds: ids })).rejects.toThrow('Clean idle');
  f.setWritable(true);
  const pending = f.resolutions.write({ operation: 'annotate', kind: 'note', text: 'Queued assertion.', claimIds: ids });
  await Promise.resolve(); // Let validation start before authority is revoked during source IO.
  f.setWritable(false);
  await expect(pending).rejects.toThrow('Clean idle');
  expect((await f.resolutions.read({ operation: 'list' })).items).toEqual([]);
  for (const name of readdirSync(f.directory).filter(name => name.includes('resolutions.sqlite'))) expect(readFileSync(join(f.directory, name)).includes(Buffer.from(canary))).toBe(false);
});
