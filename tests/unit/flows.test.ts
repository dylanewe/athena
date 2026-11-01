import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Knowledge } from '../../src/main/knowledge';
import { Sources } from '../../src/main/sources';
import { KnowledgeGateway } from '../../src/main/knowledge-bridge';
import { Resolutions } from '../../src/main/resolutions';
import { FOLDER_CONSENT, type InventorySnapshot } from '../../src/shared/inventory';
import type { Evidence } from '../../src/shared/live';
import { operationCandidates, operationFiles } from '../fixtures/operation';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-flow-')));
  const snapshot: InventorySnapshot = { roots: [{ path: directory, consent: FOLDER_CONSENT, acceptedAt: 'now', includedLocations: [] }], repositories: [], candidates: [], discovery: { status: 'complete', visited: 0, current: '', nonGitFiles: 0, failures: [] } };
  const files = operationFiles;
  for (const scope of ['shop', 'ledger']) {
    mkdirSync(join(directory, scope, '.git'), { recursive: true });
    snapshot.repositories.push({ name: scope, path: join(directory, scope), presence: 'present', documentationRoots: [], boundaries: [], fileCount: 1, examined: false });
  }
  for (const [scope, path, text] of files) writeFileSync(join(directory, scope, path), text);
  const inventory = { snapshot: () => structuredClone(snapshot) };
  const sources = new Sources(':memory:', inventory);
  const path = join(directory, 'knowledge.sqlite');
  const knowledge = new Knowledge(path, sources, inventory, () => {});
  cleanups.push(() => { knowledge.close(); sources.close(); rmSync(directory, { recursive: true, force: true }); });
  const evidence: Evidence[] = [];
  for (const [scope, file] of files) {
    const result = await sources.run('read', { root: directory, path: `${scope}/${file}`, start: 1, end: 1 });
    evidence.push({ id: `E${evidence.length + 1}`, citation: result.entries[0].citation!, text: result.entries[0].text! });
  }
  const candidates = structuredClone(operationCandidates);
  const publish = (value: unknown = candidates, options: { evidence?: Evidence[]; guard?: () => void } = {}) => knowledge.publish({ candidates: value, evidence: options.evidence ?? evidence, assertPublishable: options.guard, owner: { conversationId: 'conversation', messageId: 'answer' }, completed: true, environmentExposed: false, signal: new AbortController().signal });
  return { directory, path, sources, inventory, snapshot, knowledge, evidence, candidates, publish };
}

test.each([
  { steps: [{ name: 'Invented', service: 'C1', claim: 'C404', state: 'implementation' }], handoffs: [] },
  { handoffs: [] },
  { handoffs: [{ kind: 'synchronous', claim: 'C8' }, { kind: 'synchronous', claim: 'C7' }] },
  { handoffs: [{ kind: 'within-service', claim: 'C4' }, { kind: 'synchronous', claim: 'C8' }] },
  { steps: [{ name: 'Invented implementation', service: 'C3', claim: 'C6', state: 'implementation' }], handoffs: [] },
  { omissions: [] },
  { runtimeObserved: true },
])('malformed, mismatched and invented flow candidates roll back the entire batch: %j', async patch => {
  const f = await fixture();
  const candidates = structuredClone(f.candidates);
  Object.assign(candidates.find(candidate => candidate.flow)!.flow!, patch);
  await expect(f.publish(candidates)).rejects.toThrow();
  expect((await f.knowledge.retrieve({ operation: 'flows' })).items).toEqual([]);
  expect((await f.knowledge.retrieve({ operation: 'search', query: '' })).items).toEqual([]);
});

test('a named cross-repository operation retains ordered steps, synchronous handoffs, explicit missing implementation and version-bound claim dependencies across restart', async () => {
  const f = await fixture();
  const ids = await f.publish();
  const flow = (await f.knowledge.retrieve({ operation: 'detail', id: ids[8] })).items[0];
  expect(flow.flow?.steps.map(step => step.name)).toEqual(['Accept checkout', 'Charge account', 'Bank boundary']);
  expect(flow.flow?.steps[2]).toMatchObject({ service: ids[2], claim: ids[5], state: 'unknown' });
  expect(flow.flow?.handoffs).toEqual([{ kind: 'synchronous', claim: ids[6] }, { kind: 'synchronous', claim: ids[7] }]);
  const result = await f.knowledge.retrieve({ operation: 'flow', id: ids[8] });
  expect(result.items.map(item => item.id).sort()).toEqual([...ids].sort());
  expect(result.derivation?.checkouts.map(item => item.repository?.name).sort()).toEqual(['ledger', 'shop']);
  expect((await f.knowledge.retrieve({ operation: 'evidence', id: ids[7], index: 0 })).evidence?.text).toContain('bank.authorize()');
  const reopened = new Knowledge(f.path, f.sources, f.inventory, () => {});
  try {
    expect((await reopened.retrieve({ operation: 'flows', messageId: 'answer' })).items.map(item => item.id)).toEqual([ids[8]]);
    expect((await reopened.retrieve({ operation: 'flows', serviceId: ids[1] })).items.map(item => item.id)).toEqual([ids[8]]);
  } finally { reopened.close(); }
});

async function publishProgressively(f: Awaited<ReturnType<typeof fixture>>) {
  const ids = await f.publish(f.candidates.filter(candidate => !candidate.flow));
  const operation = structuredClone(f.candidates.find(candidate => candidate.flow)!);
  const resolved = new Map(f.candidates.filter(candidate => !candidate.flow).map((candidate, index) => [candidate.id, ids[index]]));
  operation.flow!.steps = operation.flow!.steps.map(step => ({ ...step, service: resolved.get(step.service)!, claim: resolved.get(step.claim)! }));
  operation.flow!.handoffs = operation.flow!.handoffs.map(edge => ({ ...edge, claim: resolved.get(edge.claim)! }));
  const [id] = await f.publish([operation], { evidence: [f.evidence[0]] });
  return { id, ids, operation };
}

test('supporting claims from prior investigations add transitive access, freshness, sticky invalidation and annotation version coverage to flows', async () => {
  const f = await fixture();
  const { id, ids, operation } = await publishProgressively(f);
  const resolutions = new Resolutions(':memory:', f.knowledge, () => {}, () => {});
  try {
    const annotation = await resolutions.write({ operation: 'annotate', kind: 'note', text: 'Bank internals still need investigation.', claimIds: [id] });
    expect(annotation.items[0].status).toBe('recorded-for-these-versions');
    writeFileSync(join(f.directory, 'ledger', 'uncited.ts'), 'changed();');
    expect((await f.knowledge.retrieve({ operation: 'evidence', id, index: 0 })).evidence).toBeUndefined();
    expect((await resolutions.read({ operation: 'list', claimId: id })).items[0].status).toBe('requires-reconsideration');
    rmSync(join(f.directory, 'ledger', 'uncited.ts'));
    expect((await f.knowledge.retrieve({ operation: 'flow', id })).items.find(item => item.id === id)?.freshness).toBe('stale');
    await expect(f.publish([operation], { evidence: [f.evidence[0]] })).rejects.toThrow('requires revalidation');
    f.snapshot.repositories[1].presence = 'missing';
    expect((await f.knowledge.retrieve({ operation: 'flow', id })).items).toEqual([]);
    expect((await f.knowledge.retrieve({ operation: 'flows', serviceId: ids[0] })).items).toEqual([]);
    expect((await resolutions.read({ operation: 'list', claimId: id })).items).toEqual([]);
  } finally { resolutions.close(); }
});

test('new flows reject changed observed source and live publication revocation without retaining any batch or index', async () => {
  const f = await fixture();
  writeFileSync(join(f.directory, 'ledger', 'charge.ts'), 'changed();');
  await expect(f.publish()).rejects.toThrow('changed');
  expect((await f.knowledge.retrieve({ operation: 'flows' })).items).toEqual([]);
  writeFileSync(join(f.directory, 'ledger', 'charge.ts'), operationFiles[1][2]);
  await expect(f.publish(undefined, { guard: () => { throw new Error('Sealed context'); } })).rejects.toThrow('Sealed context');
  expect((await f.knowledge.retrieve({ operation: 'search', query: '' })).items).toEqual([]);
});

test('flow inspection inherits live taint authority and cannot persist invalidation after that authority changes', async () => {
  const f = await fixture();
  const { id } = await publishProgressively(f);
  const owner = { webContentsId: 1, url: 'file:///athena/index.html' }, caller = { ...owner, isMainFrame: true };
  let writable = true;
  const gateway = new KnowledgeGateway(f.knowledge, owner, undefined, () => writable);
  writeFileSync(join(f.directory, 'ledger', 'uncited.ts'), 'changed();');
  const pending = gateway.dispatch(caller, 'retrieve', { operation: 'flow', id });
  writable = false;
  const result = await pending;
  expect(result.items.find(item => item.id === id)?.freshness).toBe('stale');
  expect(result).not.toHaveProperty('derivation');
  rmSync(join(f.directory, 'ledger', 'uncited.ts'));
  expect((await f.knowledge.retrieve({ operation: 'detail', id })).items[0].freshness).toBe('current');
});

test('flow ordering is identity-bound and independent of candidate submission order; documented/internal and unknown handoffs remain explicit', async () => {
  const f = await fixture();
  const candidates = structuredClone(f.candidates);
  candidates[3].provenance = 'declared';
  candidates[8].flow = {
    steps: [{ name: 'Documented entry', service: 'C1', claim: 'C4', state: 'documented' }, { name: 'Uncertain continuation', service: 'C1', claim: 'C4', state: 'unknown' }],
    handoffs: [{ kind: 'within-service', claim: 'C4' }], omissions: ['State transitions and alternate paths were not inspected.'],
  };
  const ids = await f.publish(candidates);
  const reverseIds = await f.publish([...candidates].reverse());
  expect(reverseIds).toEqual([...ids].reverse());
  const prior = (await f.knowledge.retrieve({ operation: 'detail', id: ids[8] })).items[0];
  expect(prior.flow?.steps.map(step => step.state)).toEqual(['documented', 'unknown']);
  candidates[8].flow.handoffs[0].kind = 'unknown';
  const updated = await f.publish(candidates);
  expect(updated[8]).not.toBe(ids[8]);
  expect((await f.knowledge.retrieve({ operation: 'detail', id: updated[8] })).items[0].flow?.handoffs[0].kind).toBe('unknown');
});

test('a flow exceeding the shared total byte envelope is withheld, never rendered as a complete partial sequence', async () => {
  const f = await fixture();
  for (const candidate of f.candidates) {
    candidate.aliases = Array.from({ length: 8 }, (_, index) => `${index}` + 'a'.repeat(119));
    candidate.summary = 'b'.repeat(500); candidate.claim = 'c'.repeat(600);
  }
  const ids = await f.publish();
  const result = await f.knowledge.retrieve({ operation: 'flow', id: ids[8] });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24 * 1024);
  expect(result.items).toEqual([]);
  expect(result.evidence).toBeUndefined();
});
