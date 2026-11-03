import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Knowledge } from '../../src/main/knowledge';
import { Sources } from '../../src/main/sources';
import { KnowledgeGateway } from '../../src/main/knowledge-bridge';
import { Resolutions } from '../../src/main/resolutions';
import { FOLDER_CONSENT, folderGranted, type InventorySnapshot } from '../../src/shared/inventory';
import type { Evidence } from '../../src/shared/live';
import type { KnowledgeCandidate, OperationFlow } from '../../src/shared/knowledge';
import { branchingCandidates, branchingFiles, operationCandidates, operationFiles, parallelCandidates, parallelFiles } from '../fixtures/operation';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture(input: { files?: readonly (readonly [string, string, string])[]; candidates?: KnowledgeCandidate[] } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-flow-')));
  const snapshot: InventorySnapshot = { roots: [{ path: directory, consent: FOLDER_CONSENT, acceptedAt: 'now', includedLocations: [] }], repositories: [], candidates: [], discovery: { status: 'complete', visited: 0, current: '', nonGitFiles: 0, failures: [] } };
  const files = input.files ?? operationFiles;
  for (const scope of ['shop', 'ledger']) {
    mkdirSync(join(directory, scope, '.git'), { recursive: true });
    snapshot.repositories.push({ name: scope, path: join(directory, scope), presence: 'present', documentationRoots: [], boundaries: [], fileCount: 1, examined: false });
  }
  for (const [scope, path, text] of files) writeFileSync(join(directory, scope, path), text);
  const inventory = { snapshot: () => structuredClone(snapshot), granted: (path: string) => folderGranted(snapshot.roots, path) };
  const sources = new Sources(':memory:', inventory);
  const path = join(directory, 'knowledge.sqlite');
  const knowledge = new Knowledge(path, sources, inventory, () => {});
  cleanups.push(() => { knowledge.close(); sources.close(); rmSync(directory, { recursive: true, force: true }); });
  const evidence: Evidence[] = [];
  for (const [scope, file] of files) {
    const result = await sources.run('read', { root: directory, path: `${scope}/${file}`, start: 1, end: 1 });
    evidence.push({ id: `E${evidence.length + 1}`, citation: result.entries[0].citation!, text: result.entries[0].text! });
  }
  const candidates = structuredClone(input.candidates ?? operationCandidates);
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

test('cache reset clears the complete flow, architecture and search indexes, rotates reuse generation, and allows explicit full re-extraction', async () => {
  const f = await fixture(); const ids = await f.publish(); const generation = f.knowledge.generation();
  await f.knowledge.clear();
  expect(f.knowledge.generation()).not.toBe(generation);
  expect((await f.knowledge.retrieve({ operation: 'flows' })).items).toEqual([]);
  expect((await f.knowledge.retrieve({ operation: 'search', query: 'checkout' })).items).toEqual([]);
  expect((await f.knowledge.retrieve({ operation: 'neighborhood', scope: 'shop', depth: 3 })).items).toEqual([]);
  expect(await f.publish()).toEqual(ids);
  expect((await f.knowledge.retrieve({ operation: 'flow', id: ids[8] })).items).toHaveLength(9);
});

test('interrupted cache-reset checkpoint recovers without replaying extraction or losing the committed empty generation', async () => {
  const f = await fixture(); const ids = await f.publish(); const generation = f.knowledge.generation();
  const reader = new DatabaseSync(f.path); reader.exec('BEGIN'); reader.prepare('SELECT * FROM claims').all();
  try {
    await expect(f.knowledge.clear()).rejects.toThrow(/checkpoint/i);
    expect(f.knowledge.cleanupStatus().cleanupPending).toBe(true);
  } finally { reader.exec('ROLLBACK'); reader.close(); }
  const emptyGeneration = f.knowledge.generation(); expect(emptyGeneration).not.toBe(generation);
  const reopened = new Knowledge(f.path, f.sources, f.inventory, () => {});
  try {
    await reopened.recoverCleanup(); await reopened.scan();
    expect(reopened.cleanupStatus().cleanupPending).toBe(false);
    expect(reopened.generation()).toBe(emptyGeneration);
    expect((await reopened.retrieve({ operation: 'detail', id: ids[8] })).items).toEqual([]);
  } finally { reopened.close(); }
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
    const reconciliation = (await resolutions.read({ operation: 'list', claimId: id })).items[0];
    expect(reconciliation).toMatchObject({ unavailable: true, status: 'requires-reconsideration', bindings: [], versions: [] });
    expect(reconciliation.text).not.toContain('Bank internals still need investigation.');
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

test('conditional success/failure and async work retain explicit endpoints rather than inventing a total order', async () => {
  const f = await fixture({ files: branchingFiles, candidates: branchingCandidates });
  const ids = await f.publish();
  const result = await f.knowledge.retrieve({ operation: 'flow', id: ids[8] });
  const flow = result.items.find(item => item.id === ids[8])!.flow!;
  expect(flow.handoffs).toEqual([
    { from: 0, to: 1, kind: 'synchronous', claim: ids[6], condition: 'Valid checkout / success' },
    { from: 0, to: 3, kind: 'within-service', claim: ids[9], condition: 'Invalid checkout / failure' },
    { from: 1, to: 4, kind: 'within-service', claim: ids[10] },
    { from: 4, to: 2, kind: 'asynchronous', claim: ids[7], omissions: ['Consumer subscription and delivery guarantees were not inspected.'] },
  ]);
  expect(flow.steps[2]).toMatchObject({ state: 'unknown', omissions: ['Consumer implementation is unavailable; delivery and completion are not established.'] });
  const dependencies = await f.knowledge.retrieve({ operation: 'expand', id: ids[8], kinds: ['depends-on'], limit: 20 });
  expect(dependencies.items.map(item => item.id)).toContain(ids[7]);
  const reversed = await f.publish([...f.candidates].reverse());
  expect(reversed).toEqual([...ids].reverse());
  f.candidates[8].flow!.handoffs[0].condition = 'Checkout is valid / success';
  const changed = await f.publish();
  expect(changed[8]).not.toBe(ids[8]);
});

test('an evidenced async producer and consumer preserve the event boundary without inventing delivery or a join', async () => {
  const files = [
    ['shop', 'checkout.ts', 'export function checkout() { events.publish("checkout.accepted", order); }\n'],
    ['ledger', 'charge.ts', 'events.subscribe("checkout.accepted", order => bank.authorize(order));\n'],
    operationFiles[2],
  ] as const;
  const f = await fixture({ files });
  f.candidates[6].architecture = { type: 'event', from: 'C1', to: 'C2', mechanism: 'checkout.accepted producer/subscriber' };
  f.candidates[6].evidenceIds = ['E1', 'E2'];
  f.candidates[8].flow!.handoffs[0] = { from: 0, to: 1, kind: 'asynchronous', claim: 'C7', omissions: ['Delivery guarantees and completion timing are unverified.'] };
  f.candidates[8].flow!.handoffs[1] = { from: 1, to: 2, kind: 'synchronous', claim: 'C8' };
  const ids = await f.publish();
  const result = await f.knowledge.retrieve({ operation: 'flow', id: ids[8] });
  const flow = result.items.find(item => item.id === ids[8])!.flow!;
  expect(flow.steps[1]).toMatchObject({ state: 'implementation', service: ids[1] });
  expect(flow.handoffs[0]).toMatchObject({ kind: 'asynchronous', from: 0, to: 1, claim: ids[6] });
  expect(result.items.find(item => item.id === ids[6])!.evidence).toHaveLength(2);
  expect(flow.steps.map(step => step.kind)).not.toContain('join');
});

test('retries and loops remain finite annotations with persisted evidence and transitive invalidation', async () => {
  const f = await fixture({ files: branchingFiles, candidates: branchingCandidates });
  const ids = await f.publish();
  const reopened = new Knowledge(f.path, f.sources, f.inventory, () => {});
  try {
    const flow = (await reopened.retrieve({ operation: 'flow', id: ids[8] })).items.find(item => item.id === ids[8])!.flow!;
    expect(flow.steps).toHaveLength(5);
    expect(flow.steps[1]).toMatchObject({ kind: 'retry', annotation: 'At most 3 attempts after temporary failure; final failure throws. Not an application/model retry.' });
    expect(flow.steps[4]).toMatchObject({ kind: 'loop', claim: ids[10] });
    expect(flow.handoffs[3]).toMatchObject({ from: 4, to: 2, kind: 'asynchronous', claim: ids[7] });
    writeFileSync(join(f.directory, 'ledger', 'charge.ts'), 'changed retry and publication policy');
    expect((await reopened.retrieve({ operation: 'flow', id: ids[8] })).items.find(item => item.id === ids[8])!.freshness).toBe('stale');
    f.snapshot.roots = [];
    expect((await reopened.retrieve({ operation: 'flow', id: ids[8] })).items).toEqual([]);
  } finally { reopened.close(); }
});

test.each(['implementation', 'unknown'] as const)('explicit parallel fan-out and a %s join do not imply consumer completion', async state => {
  const f = await fixture({ files: parallelFiles, candidates: parallelCandidates });
  const candidates = structuredClone(f.candidates);
  candidates[8].flow!.steps[3].state = state;
  candidates[8].flow!.steps[3].omissions = ['Consumer processing has no evidenced join.'];
  if (state === 'unknown') {
    candidates[8].flow!.steps[1].state = 'unknown';
    candidates[8].flow!.steps[3].annotation = 'Completion is unresolved; worker implementation needs further investigation.';
  }
  const ids = await f.publish(candidates);
  const result = await f.knowledge.retrieve({ operation: 'flow', id: ids[8] });
  const flow = result.items.find(item => item.id === ids[8])!.flow!;
  expect(flow.steps[0]).toMatchObject({ kind: 'parallel', state: 'implementation' });
  expect(flow.steps[3]).toMatchObject({ kind: 'join', state, omissions: ['Consumer processing has no evidenced join.'] });
  expect(flow.handoffs.slice(2).map(edge => edge.kind)).toEqual(['unknown', 'within-service']);
  expect(result.items.every(item => item.freshness === 'current')).toBe(true);
});

const malformedFlows: ((flow: OperationFlow) => void)[] = [
  flow => { flow.handoffs[0].to = 5; },
  flow => { delete flow.handoffs[0].from; },
  flow => { flow.handoffs[0].to = 0; },
  flow => { flow.handoffs.push({ from: 2, to: 0, kind: 'unknown', claim: 'C6' }); },
  flow => { flow.handoffs.push({ ...flow.handoffs[0] }); },
  flow => { delete flow.handoffs[0].condition; },
  flow => { delete flow.steps[0].kind; },
  flow => { flow.steps[0].kind = 'parallel'; },
  flow => { flow.handoffs[1].condition = flow.handoffs[0].condition; },
  flow => { flow.handoffs.splice(1, 1); },
  flow => { flow.handoffs.push({ from: 3, to: 4, kind: 'unknown', claim: 'C10' }); },
  flow => { flow.handoffs[3].claim = 'C7'; },
  flow => { flow.steps[2].state = 'implementation'; },
  flow => { delete flow.steps[1].annotation; },
  flow => { delete flow.steps[4].annotation; },
  flow => { flow.steps[4].kind = 'join'; },
  flow => { flow.steps[4].claim = 'C9'; },
];
test.each(malformedFlows)('malformed/cyclic expanded submissions cannot publish even their ordinary support (%#)', async mutate => {
  const f = await fixture({ files: branchingFiles, candidates: branchingCandidates });
  mutate(f.candidates[8].flow!);
  await expect(f.publish()).rejects.toThrow();
  expect((await f.knowledge.retrieve({ operation: 'search', query: '' })).items).toEqual([]);
});

test('expanded flows cannot bypass the shared 20-result claim bound through retained references', async () => {
  const f = await fixture();
  const base = f.candidates[3];
  const supports: KnowledgeCandidate[] = Array.from({ length: 12 }, (_, i) => ({ ...base, id: `C${i + 1}`, topic: `Support ${i}`, ...(i < 6 ? { kind: 'entity', architecture: { type: 'service' } } : {}) }));
  const ids = await f.publish(supports);
  const edgeIds = await f.publish(Array.from({ length: 8 }, (_, i) => ({ ...base, id: `C${i + 1}`, topic: `Gap ${i}` })));
  const flow: OperationFlow = {
    steps: ids.slice(0, 6).map((service, i) => ({ name: `Portion ${i}`, service, claim: ids[i + 6], state: 'unknown', kind: i === 0 ? 'branch' : i < 3 ? 'parallel' : 'join' })),
    handoffs: [[0, 1], [0, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 5], [4, 5]].map(([from, to], i) => ({ from, to, kind: 'unknown', claim: edgeIds[i], ...(from === 0 ? { condition: i === 0 ? 'Success' : 'Failure' } : {}) })),
    omissions: ['Concurrency/completion and missing links remain unresolved.'],
  };
  await expect(f.publish([{ ...f.candidates[8], flow }])).rejects.toThrow('shared result claim bound');
  expect((await f.knowledge.retrieve({ operation: 'flows' })).items).toEqual([]);
});

test.each(['ordered', 'expanded'])('a %s flow exceeding the shared total byte envelope is withheld, never rendered as a complete partial sequence', async scenario => {
  const f = await fixture(scenario === 'expanded' ? { files: branchingFiles, candidates: branchingCandidates } : {});
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
