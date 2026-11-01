import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Knowledge } from '../../src/main/knowledge';
import { Sources } from '../../src/main/sources';
import { FOLDER_CONSENT, type InventorySnapshot } from '../../src/shared/inventory';
import type { Evidence } from '../../src/shared/live';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-map-')));
  const snapshot: InventorySnapshot = { roots: [{ path: directory, consent: FOLDER_CONSENT, acceptedAt: 'now', includedLocations: [] }], repositories: [], candidates: [], discovery: { status: 'complete', visited: 0, current: '', nonGitFiles: 0, failures: [] } };
  for (const name of ['shop', 'ledger']) {
    mkdirSync(join(directory, name, '.git'), { recursive: true });
    writeFileSync(join(directory, name, 'services.ts'), name === 'shop' ? 'export const api = serve();\nexport const worker = consume("orders");\napi.get("/balance", ledger);\nworker.store("postgres://orders");\n' : 'export const api = serve("/balance");\n');
    snapshot.repositories.push({ name, path: join(directory, name), presence: 'present', documentationRoots: [], boundaries: [], fileCount: 1, examined: false });
  }
  const inventory = { snapshot: () => structuredClone(snapshot) };
  const sources = new Sources(':memory:', inventory);
  const path = join(directory, 'knowledge.sqlite');
  const knowledge = new Knowledge(path, sources, inventory, () => {});
  cleanups.push(() => { knowledge.close(); sources.close(); rmSync(directory, { recursive: true, force: true }); });
  const evidence: Evidence[] = [];
  for (const name of ['shop', 'ledger']) {
    const read = await sources.run('read', { root: directory, path: `${name}/services.ts`, start: 1, end: 4 });
    evidence.push({ id: `E${evidence.length + 1}`, citation: read.entries[0].citation!, text: read.entries[0].text! });
  }
  const entity = (id: string, topic: string, scope = 'shop', type = 'service') => ({ id, scope, topic, summary: `${topic} boundary`, kind: 'entity', claim: `${topic} is defined in ${scope}.`, provenance: 'statically-inferred', perspective: 'current', evidenceIds: [scope === 'shop' ? 'E1' : 'E2'], relations: [], architecture: { type } });
  const connection = (id: string, from: string, to: string, type = 'api-call') => ({ ...entity(id, `${from} to ${to}`), kind: 'relationship', claim: 'The caller explicitly uses the target.', architecture: { type, from, to, mechanism: 'GET /balance' } });
  const publish = (candidates: unknown, observed = evidence, owner = 'answer') => knowledge.publish({ candidates, evidence: observed, owner: { conversationId: 'conversation', messageId: owner }, completed: true, environmentExposed: false, signal: new AbortController().signal });
  return { directory, path, inventory, sources, knowledge, evidence, entity, connection, publish, snapshot };
}

test('explicit external stores and unresolved names stay separate from repositories and support typed bounded incoming and outgoing expansion', async () => {
  const f = await fixture();
  const external = { ...f.entity('C3', 'Orders store'), architecture: { type: 'external', resource: 'datastore', address: 'postgres://orders' } };
  const unresolved = { ...f.entity('C4', 'API'), architecture: { type: 'unresolved', resource: 'service', address: 'ledger' } };
  const [api, worker, store, unknown, event, usage, call] = await f.publish([
    f.entity('C1', 'API'), f.entity('C2', 'Worker'), external, unresolved,
    { ...f.connection('C5', 'C1', 'C2', 'event'), architecture: { type: 'event', from: 'C1', to: 'C2', mechanism: 'orders topic' } },
    f.connection('C6', 'C2', 'C3', 'data-store'), f.connection('C7', 'C1', 'C4'),
  ]);
  expect((await f.knowledge.retrieve({ operation: 'neighborhood', id: api, depth: 0 })).items.map(item => item.id)).toEqual([api]);
  const one = await f.knowledge.retrieve({ operation: 'neighborhood', id: api, depth: 1, kinds: ['event'], limit: 20 });
  expect(one.items.map(item => item.id).sort()).toEqual([api, worker, event].sort());
  const two = await f.knowledge.retrieve({ operation: 'neighborhood', id: api, depth: 2, limit: 20 });
  expect(two.items.map(item => item.id).sort()).toEqual([api, worker, store, unknown, event, usage, call].sort());
  expect(two.items.find(item => item.id === unknown)).toMatchObject({ architecture: { type: 'unresolved', address: 'ledger' } });
  expect((await f.knowledge.retrieve({ operation: 'neighborhood', id: store, depth: 1, limit: 20 })).items.map(item => item.id).sort()).toEqual([store, usage, worker].sort());
  expect((await f.knowledge.retrieve({ operation: 'neighborhood', id: api, depth: 3, limit: 2 })).items.length).toBeLessThanOrEqual(2);
  expect(Buffer.byteLength(JSON.stringify(two))).toBeLessThanOrEqual(24 * 1024);
});

test.each(['shared-library', 'deployment'] as const)('concrete %s usage and interfaces are independently evidence-backed claims, not inferred technology edges', async type => {
  const f = await fixture();
  const [api, endpoint, dependency] = await f.publish([f.entity('C1', 'API'), f.entity('C2', 'GET /balance', 'shop', 'interface'), f.connection('C3', 'C1', 'C2', type)]);
  expect((await f.knowledge.retrieve({ operation: 'neighborhood', id: api, depth: 1, kinds: [type], limit: 20 })).items.map(item => item.id).sort()).toEqual([api, endpoint, dependency].sort());
  const [other] = await f.publish([f.entity('C1', 'API', 'ledger')], [f.evidence[1]], 'other');
  expect((await f.knowledge.retrieve({ operation: 'neighborhood', id: other, depth: 3 })).items.map(item => item.id)).toEqual([other]);
});

test('endpoint dependency revocation and uncited checkout edits invalidate relationship evidence transitively and never revive it on revert', async () => {
  const f = await fixture();
  const [target] = await f.publish([f.entity('C1', 'API', 'ledger')], [f.evidence[1]], 'target');
  const [caller, edge] = await f.publish([f.entity('C1', 'API'), f.connection('C2', 'C1', target)], [f.evidence[0]]);
  writeFileSync(join(f.directory, 'ledger', 'config.ts'), 'changed();');
  expect((await f.knowledge.retrieve({ operation: 'evidence', id: edge, index: 0 })).evidence).toBeUndefined();
  rmSync(join(f.directory, 'ledger', 'config.ts'));
  expect((await f.knowledge.retrieve({ operation: 'detail', id: edge })).items[0].freshness).toBe('stale');
  expect((await f.knowledge.retrieve({ operation: 'detail', id: caller })).items[0].freshness).toBe('current');
  f.snapshot.repositories[1].presence = 'missing';
  expect((await f.knowledge.retrieve({ operation: 'detail', id: edge })).items).toEqual([]);
  expect((await f.knowledge.retrieve({ operation: 'neighborhood', id: caller, depth: 3 })).items.map(item => item.id)).toEqual([caller]);
});

test.each([
  { kind: 'entity', architecture: undefined },
  { architecture: { type: 'runtime-observed' } },
  { architecture: { type: 'service', arbitrary: 'write' } },
  { kind: 'relationship', architecture: { type: 'api-call', from: 'C1', to: 'API', mechanism: 'GET /' } },
  { kind: 'relationship', architecture: { type: 'similar-technology', from: 'C1', to: 'C2', mechanism: 'TypeScript' } },
  { kind: 'relationship', architecture: { type: 'api-call', from: 'C1', to: 'C2', mechanism: '  ' } },
  { kind: 'relationship', architecture: { type: 'api-call', from: 'C1', to: 'C1', mechanism: 'GET /' } },
  { evidenceIds: ['E999'] },
])('malformed architecture candidates withhold the whole batch: %j', async malformed => {
  const f = await fixture();
  const broken = { ...f.entity('C2', 'Broken'), ...malformed };
  await expect(f.publish([f.entity('C1', 'API'), broken])).rejects.toThrow();
  expect((await f.knowledge.retrieve({ operation: 'search', query: '' })).items).toEqual([]);
});

test.each([{ depth: 4 }, { depth: -1 }, { depth: 1, limit: 21 }, { depth: 1, kinds: ['similarity'] }, { depth: 1, query: 'SQL' }])('rejects unbounded or untyped traversal: %j', async request => {
  const f = await fixture();
  await expect(f.knowledge.retrieve({ operation: 'neighborhood', ...request } as never)).rejects.toThrow('Invalid bounded');
});

test('publication resolves explicit endpoints independently of candidate order, never interpreting a colliding name as an ID', async () => {
  const f = await fixture();
  const [edge, service, target] = await f.publish([f.connection('C3', 'C1', 'C2'), f.entity('C1', 'API'), f.entity('C2', 'API', 'ledger')]);
  expect((await f.knowledge.retrieve({ operation: 'detail', id: edge })).items[0].architecture).toMatchObject({ from: service, to: target });
  await expect(f.publish([f.connection('C4', service, 'API')])).rejects.toThrow('explicit entity');
});

test('progressive named services retain repository-scoped collisions, concrete cross-repository calls and navigable evidence across restart', async () => {
  const f = await fixture();
  const [api, worker, ledger, call] = await f.publish([f.entity('C1', 'API'), f.entity('C2', 'Worker'), f.entity('C3', 'API', 'ledger'), f.connection('C4', 'C1', 'C3')]);
  expect(api).not.toBe(ledger);
  const result = await f.knowledge.retrieve({ operation: 'neighborhood', id: api, depth: 1, limit: 20 });
  expect(result.items.map(item => item.id).sort()).toEqual([api, ledger, call].sort());
  expect(result.items.find(item => item.id === call)).toMatchObject({ architecture: { type: 'api-call', from: api, to: ledger, mechanism: 'GET /balance' }, validation: 'unchecked', provenance: 'statically-inferred' });
  expect((await f.knowledge.retrieve({ operation: 'evidence', id: call, index: 0 })).evidence?.text).toContain('api.get');
  const reopened = new Knowledge(f.path, f.sources, f.inventory, () => {});
  try {
    expect((await reopened.retrieve({ operation: 'neighborhood', messageId: 'answer', depth: 0, limit: 20 })).items.map(item => item.id).sort()).toEqual([api, worker, ledger].sort());
  } finally { reopened.close(); }
});
