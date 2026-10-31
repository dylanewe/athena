import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Knowledge } from '../../src/main/knowledge';
import { Sources } from '../../src/main/sources';
import { KnowledgeGateway } from '../../src/main/knowledge-bridge';
import { FOLDER_CONSENT, type InventorySnapshot } from '../../src/shared/inventory';
import type { Evidence } from '../../src/shared/live';
import { KNOWLEDGE_LIMITS } from '../../src/shared/knowledge';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-knowledge-')));
const root = join(directory, 'sources'); mkdirSync(join(root, 'api', '.git'), { recursive: true });
writeFileSync(join(root, 'api', 'service.ts'), 'export function serve() { return "ready"; }\n');
writeFileSync(join(root, 'api', 'README.md'), 'The service handles requests.\n');
const snapshot: InventorySnapshot = { roots: [{ path: root, consent: FOLDER_CONSENT, acceptedAt: 'now', includedLocations: [] }], repositories: [{ name: 'public-api', path: join(root, 'api'), presence: 'present', documentationRoots: [], boundaries: [], fileCount: 2, examined: false }], candidates: [], discovery: { status: 'complete', visited: 0, current: '', nonGitFiles: 0, failures: [] } };
const inventory = { snapshot: () => structuredClone(snapshot) };
const sources = new Sources(':memory:', inventory);
const knowledge = new Knowledge(join(directory, 'knowledge.sqlite'), sources, inventory, () => {});
beforeEach(() => {
  writeFileSync(join(root, 'api', 'service.ts'), 'export function serve() { return "ready"; }\n');
  writeFileSync(join(root, 'api', 'README.md'), 'The service handles requests.\n');
});
afterEach(async () => { await knowledge.clear(); });
afterAll(() => { knowledge.close(); sources.close(); rmSync(directory, { recursive: true, force: true }); });
async function evidence(): Promise<Evidence[]> {
  return Promise.all(['api/service.ts', 'api/README.md'].map(async (path, index) => {
    const result = await sources.run('read', { root, path, start: 1, end: 1 });
    const entry = result.entries[0];
    return { id: `E${index + 1}`, citation: entry.citation!, text: entry.text! };
  }));
}
const candidate = () => ({ id: 'C1', scope: 'public-api', topic: 'Request serving', summary: 'A small request-serving boundary.', kind: 'responsibility', claim: 'The service handles requests.', provenance: 'declared', perspective: 'intended', evidenceIds: ['E2'], relations: [] });
async function publish(candidates: unknown = [candidate()], overrides = {}) {
  return knowledge.publish({ owner: { conversationId: 'conversation-1', messageId: 'message-1' }, candidates, evidence: await evidence(), completed: true, environmentExposed: false, signal: new AbortController().signal, ...overrides });
}
test('search ranks names and aliases within repository scope and retrieves retained evidence text', async () => {
  const [id] = await publish([{ ...candidate(), aliases: ['Gateway'] }]);
  const result = await knowledge.retrieve({ operation: 'search', query: 'gateway', scope: 'PUBLIC-API', exact: true });
  expect(result.items).toMatchObject([{ id, scope: 'public-api', aliases: ['Gateway'], freshness: 'current', validation: 'supported' }]);
  expect((await knowledge.retrieve({ operation: 'search', query: 'requests' })).items[0].id).toBe(id);
  expect((await knowledge.retrieve({ operation: 'search', query: 'serve' })).items).toEqual([]); // Uncited inspected file is not retained evidence.
  expect((await knowledge.retrieve({ operation: 'search', query: 'gateway', scope: 'api', exact: true })).items).toEqual([]);
});

test('retrieval bounds ranked pages, exposes detail/evidence pointers, and captures lexical paraphrase misses', async () => {
  const ids = await publish(Array.from({ length: 12 }, (_, index) => ({ ...candidate(), id: `C${index + 1}`, topic: index === 0 ? 'Gateway' : `Topic ${index}`, summary: 'Gateway serving boundary.' })));
  const first = await knowledge.retrieve({ operation: 'search', query: 'gateway', limit: 2 });
  expect(first.items).toHaveLength(2);
  expect(first.items[0].id).toBe(ids[0]); // Topic hits outrank summary-only hits.
  expect(first.nextOffset).toBe(2);
  const second = await knowledge.retrieve({ operation: 'search', query: 'gateway', limit: 2, offset: first.nextOffset });
  expect(second.items).toHaveLength(2);
  expect(second.items.some(item => first.items.some(previous => previous.id === item.id))).toBe(false);
  const detail = await knowledge.retrieve({ operation: 'detail', id: ids[0] });
  expect(detail.items[0].evidence).toMatchObject([{ index: 0, citation: { path: 'api/README.md' } }]);
  const excerpt = await knowledge.retrieve({ operation: 'evidence', id: ids[0], index: 0 });
  expect(excerpt.items[0].evidence[0].excerpt).toBe('The service handles requests.');
  expect(excerpt.evidence?.text).toBe('The service handles requests.');
  for (const query of ['HTTP ingress', 'accept incoming traffic', 'serves network clients']) {
    const missed = await knowledge.retrieve({ operation: 'search', query });
    expect(missed.items).toEqual([]);
    expect(missed.notice).toContain('No match is not proof of absence');
  }
  await expect(knowledge.retrieve({ operation: 'search', query: 'x', limit: 21 })).rejects.toThrow();
  await expect(knowledge.retrieve({ operation: 'search', query: 'x', exact: true })).rejects.toThrow('scope');
});

test('retrieval withholds revoked/ignored material and labels changed dependencies as stale leads without runtime evidence', async () => {
  const [id] = await publish();
  writeFileSync(join(root, 'api', 'service.ts'), 'changed');
  expect((await knowledge.retrieve({ operation: 'search', query: 'requests' })).items[0]).toMatchObject({ freshness: 'stale', validation: 'stale' });
  expect((await knowledge.retrieve({ operation: 'evidence', id, index: 0 })).evidence).toBeUndefined();
  writeFileSync(join(root, 'api', '.gitignore'), 'README.md\n');
  try {
    for (const request of [{ operation: 'search', query: 'requests' }, { operation: 'detail', id }, { operation: 'evidence', id, index: 0 }] as const) expect((await knowledge.retrieve(request)).items).toEqual([]);
  } finally { rmSync(join(root, 'api', '.gitignore')); }
  const roots = snapshot.roots; snapshot.roots = [];
  try { expect((await knowledge.retrieve({ operation: 'search', query: '' })).items).toEqual([]); }
  finally { snapshot.roots = roots; }
});

test('bounded typed relationship expansion composes independently of a graph UI and preserves dependency freshness', async () => {
  const [first, second, third] = await publish([
    candidate(),
    { ...candidate(), id: 'C2', topic: 'Serving', relations: [{ kind: 'supports', target: 'C1' }] },
    { ...candidate(), id: 'C3', topic: 'Operations', relations: [{ kind: 'depends-on', target: 'C1' }, { kind: 'supports', target: 'C2' }] },
  ]);
  const page = await knowledge.retrieve({ operation: 'expand', id: third, kinds: ['depends-on', 'supports'], limit: 1 });
  expect(page.items.map(item => item.id)).toEqual([first]);
  expect(page.nextOffset).toBe(1);
  expect(page.edges).toEqual([{ source: third, kind: 'depends-on', target: first }]);
  expect((await knowledge.retrieve({ operation: 'expand', id: third, kinds: ['supports'] })).items.map(item => item.id)).toEqual([second]);
  expect((await knowledge.retrieve({ operation: 'expand', id: third, kinds: ['conflicts-with'] })).items).toEqual([]);
  expect((await knowledge.retrieve({ operation: 'detail', id: third })).items[0]).toMatchObject({ detail: { dependencyCount: 2 }, relations: [{ kind: 'depends-on', target: first, owners: [{ messageId: 'message-1' }] }, { kind: 'supports', target: second, owners: [{ messageId: 'message-1' }] }] });
  const roots = snapshot.roots; snapshot.roots = [];
  try { expect((await knowledge.retrieve({ operation: 'expand', id: third, kinds: ['supports'] })).items).toEqual([]); }
  finally { snapshot.roots = roots; }
});

test('large retained excerpts and wide matching ledgers never exceed result or excerpt byte bounds', async () => {
  writeFileSync(join(root, 'api', 'README.md'), 'gateway '.repeat(1500) + '\n');
  const observed = (await evidence()).slice(1);
  const ids = await publish(Array.from({ length: 12 }, (_, i) => ({ ...candidate(), id: `C${i + 1}`, topic: `Gateway ${i}`, summary: 'a'.repeat(500), claim: 'b'.repeat(600) })), { evidence: observed });
  const result = await knowledge.retrieve({ operation: 'search', query: 'gateway', limit: 20 });
  expect(result.items.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.bytes);
  const excerpt = await knowledge.retrieve({ operation: 'evidence', id: ids[0], index: 0 });
  expect(excerpt.items[0].evidence[0]).toMatchObject({ truncated: true });
  expect(excerpt.items[0].evidence[0].excerpt).toHaveLength(1200);
  expect(Buffer.byteLength(JSON.stringify(excerpt))).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.bytes);
});

test('search persists across reopen, clears transactionally, and treats FTS/SQL-looking queries as literal data', async () => {
  const [id] = await publish();
  const reopened = new Knowledge(join(directory, 'knowledge.sqlite'), sources, inventory, () => {});
  try {
    expect((await reopened.retrieve({ operation: 'search', query: 'requests' })).items[0].id).toBe(id);
    expect((await reopened.retrieve({ operation: 'search', query: '\" OR 1 DROP TABLE claims --' })).items).toEqual([]);
    expect((await reopened.retrieve({ operation: 'search', query: '*' })).items).toEqual([]);
    await reopened.clear();
    expect((await knowledge.retrieve({ operation: 'search', query: 'requests' })).items).toEqual([]);
  } finally { reopened.close(); }
});

test('an existing pre-search knowledge database gets a local index backfill without changing record identity', async () => {
  const [id] = await publish();
  const oldProfile = new DatabaseSync(join(directory, 'knowledge.sqlite'));
  try { oldProfile.exec('DROP TABLE knowledge_fts; DROP TABLE knowledge_names; DROP TABLE knowledge_index_version'); }
  finally { oldProfile.close(); }
  const upgraded = new Knowledge(join(directory, 'knowledge.sqlite'), sources, inventory, () => {});
  try {
    expect((await upgraded.retrieve({ operation: 'search', query: 'Request serving', scope: 'PUBLIC-API', exact: true })).items[0].id).toBe(id);
    expect((await upgraded.retrieve({ operation: 'search', query: 'requests' })).items[0].id).toBe(id);
  } finally { upgraded.close(); }
});

test('normalization retains concise topics, declarations, source spans and inspected dependencies across restart', async () => {
  const ids = await publish();
  const records = await knowledge.inspect();
  expect(ids).toHaveLength(1);
  expect(records[0]).toMatchObject({ id: ids[0], scope: 'public-api', topic: 'Request serving', summary: 'A small request-serving boundary.', claim: 'The service handles requests.', provenance: 'declared', perspective: 'intended', validation: 'supported', evidence: [{ citation: { path: 'api/README.md', start: 1, end: 1, contentIdentity: expect.stringMatching(/^sha256:/) } }], dependencies: [{ path: 'api/service.ts' }, { path: 'api/README.md' }], owners: [{ messageId: 'message-1' }] });
  const reopened = new Knowledge(join(directory, 'knowledge.sqlite'), sources, inventory, () => {});
  try { expect(await reopened.inspect()).toEqual(records); } finally { reopened.close(); }
});

test('repeated exact normalization is idempotent, reconciles aliases and retains independent ownership', async () => {
  const first = await publish();
  const second = await publish([{ ...candidate(), id: 'C9', scope: 'PUBLIC-API' }], { owner: { conversationId: 'conversation-2', messageId: 'message-2' } });
  expect(second).toEqual(first);
  const records = await knowledge.inspect();
  expect(records).toHaveLength(1);
  expect(records[0].owners).toEqual([{ conversationId: 'conversation-1', messageId: 'message-1' }, { conversationId: 'conversation-2', messageId: 'message-2' }]);
});

test('conflicting implementation and intent remain separate with symmetric traceable conflict links', async () => {
  const ids = await publish([candidate(), { ...candidate(), id: 'C2', provenance: 'statically-inferred', perspective: 'current', claim: 'Serving is a static ready response, not a request handler.', evidenceIds: ['E1'], relations: [{ kind: 'conflicts-with', target: 'C1' }] }]);
  const records = await knowledge.inspect();
  expect(records.map(record => record.validation)).toEqual(['conflicting', 'conflicting']);
  expect(records[0]).toMatchObject({ perspective: 'intended', relations: [{ kind: 'conflicts-with', target: ids[1] }] });
  expect(records[1]).toMatchObject({ provenance: 'statically-inferred', perspective: 'current', relations: [{ kind: 'conflicts-with', target: ids[0] }] });
  await publish([{ ...candidate(), id: 'C3', claim: 'Requests are handled by the service.' }]);
  expect(await knowledge.inspect()).toHaveLength(3); // No semantic equivalence merge.
});

test.each([
  [{ ...candidate(), sql: 'DROP TABLE claims' }],
  [{ ...candidate(), evidenceIds: ['E99'] }],
  [{ ...candidate(), provenance: 'observed-at-runtime' }],
  [{ ...candidate(), scope: 'api' }], // Physical directory name is not its registered alias.
  [{ ...candidate(), relations: [{ kind: 'depends-on', target: 'Knonexistent' }] }],
  [candidate(), candidate()],
].map(candidates => ({ candidates })))('malformed submissions, invented citations and identities fail as a whole', async ({ candidates }) => {
  await expect(publish(candidates)).rejects.toThrow();
  expect(await knowledge.inspect()).toEqual([]);
});

test('schema-valid inference remains explicitly unchecked, never semantic certification', async () => {
  await publish([{ ...candidate(), provenance: 'statically-inferred', perspective: 'current', evidenceIds: ['E1'] }]);
  expect((await knowledge.inspect())[0]).toMatchObject({ validation: 'unchecked', validationNote: expect.stringContaining('semantic truth not independently validated') });
});

test('mutation of an uncited inspected dependency before commit rolls back the whole publication', async () => {
  let checks = 0;
  await expect(publish(undefined, { assertPublishable: () => { if (++checks === 2) writeFileSync(join(root, 'api', 'service.ts'), 'changed'); } })).rejects.toThrow('changed');
  expect(await knowledge.inspect()).toEqual([]);
});

test('a storage failure after the first claim insert rolls back claims, ownership and relationships', async () => {
  const fault = new DatabaseSync(join(directory, 'knowledge.sqlite'));
  try {
    fault.exec("CREATE TRIGGER fail_second BEFORE INSERT ON claims WHEN json_extract(NEW.value, '$.topic') = 'Failure' BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END");
    await expect(publish([candidate(), { ...candidate(), id: 'C2', topic: 'Failure', relations: [{ kind: 'depends-on', target: 'C1' }] }])).rejects.toThrow('fixture disk failure');
    expect(await knowledge.inspect()).toEqual([]);
    expect((await knowledge.retrieve({ operation: 'search', query: '' })).items).toEqual([]);
  } finally { fault.exec('DROP TRIGGER fail_second'); fault.close(); }
  await publish();
  expect((await knowledge.inspect())[0].owners).toHaveLength(1);
});

test.each(['before', 'during'] as const)('cancellation %s publication cannot retain unfinished knowledge', async when => {
  const controller = new AbortController(); let checks = 0;
  if (when === 'before') controller.abort();
  await expect(publish(undefined, { signal: controller.signal, assertPublishable: () => { if (++checks === 3) { controller.abort(); controller.signal.throwIfAborted(); } } })).rejects.toThrow();
  expect(await knowledge.inspect()).toEqual([]);
});

test.each([{ completed: false }, { environmentExposed: true }])('failed or environment-exposed extraction cannot enter the database', async overrides => {
  await expect(publish(undefined, overrides)).rejects.toThrow('completed, unexposed');
  expect(await knowledge.inspect()).toEqual([]);
});

test('freshness propagates only through explicit dependencies and keeps historical material inspectable', async () => {
  const [first] = await publish();
  // This claim depends only on docs directly, plus an explicit dependency on the first claim.
  await publish([{ ...candidate(), topic: 'Operations', kind: 'operation', relations: [{ kind: 'depends-on', target: first }] }], { evidence: (await evidence()).slice(1) });
  writeFileSync(join(root, 'api', 'service.ts'), 'changed');
  expect((await knowledge.inspect()).map(record => record.validation)).toEqual(['stale', 'stale']);
  await expect(publish([{ ...candidate(), topic: 'New', relations: [{ kind: 'supports', target: first }] }], { evidence: (await evidence()).slice(1) })).rejects.toThrow('changed');
});

test('separate aliases do not merge repositories with the same basename or matching source text', async () => {
  const [first] = await publish();
  const other = join(root, 'other', 'api'); mkdirSync(join(other, '.git'), { recursive: true });
  writeFileSync(join(other, 'README.md'), 'The service handles requests.\n');
  snapshot.repositories.push({ ...snapshot.repositories[0], name: 'private-api', path: other });
  try {
    const result = await sources.run('read', { root, path: 'other/api/README.md', start: 1, end: 1 });
    const entry = result.entries[0];
    const ids = await publish([{ ...candidate(), scope: 'private-api', evidenceIds: ['E1'] }], { evidence: [{ id: 'E1', citation: entry.citation!, text: entry.text! }] });
    expect(ids[0]).not.toBe(first);
    expect((await knowledge.inspect()).map(record => record.scope)).toEqual(['public-api', 'private-api']);
    expect((await knowledge.retrieve({ operation: 'search', query: 'Request serving', scope: 'PUBLIC-API', exact: true })).items.map(item => item.id)).toEqual([first]);
    expect((await knowledge.retrieve({ operation: 'search', query: 'Request serving', scope: 'private-api', exact: true })).items.map(item => item.id)).toEqual(ids);
    expect((await knowledge.retrieve({ operation: 'search', query: 'requests' })).items).toHaveLength(2);
  } finally { snapshot.repositories.pop(); rmSync(join(root, 'other'), { recursive: true }); }
});

test('non-Git structured text retains a designated-folder identity without requiring a manifest', async () => {
  writeFileSync(join(root, 'operations.yaml'), 'restart_policy: manual\n');
  const result = await sources.run('read', { root, path: 'operations.yaml', start: 1, end: 1 });
  const entry = result.entries[0];
  await publish([{ ...candidate(), scope: `folder:${root}`, topic: 'Operations', kind: 'operation', claim: 'Restarts are intended to be manual.', evidenceIds: ['E1'] }], { evidence: [{ id: 'E1', citation: entry.citation!, text: entry.text! }] });
  expect((await knowledge.inspect())[0]).toMatchObject({ scope: `folder:${root}`, kind: 'operation', validation: 'unchecked', evidence: [{ citation: { repository: null } }] });
});

test('revoked folder consent prevents reuse while leaving stale knowledge inspectable', async () => {
  await publish();
  const roots = snapshot.roots; snapshot.roots = [];
  try {
    expect((await knowledge.inspect())[0].validation).toBe('stale');
    expect((await knowledge.retrieve({ operation: 'search', query: '' })).items).toEqual([]);
  } finally { snapshot.roots = roots; }
});

test('knowledge IPC is read-only and rejects foreign callers, payloads and publication commands', async () => {
  const owner = { webContentsId: 1, url: 'file:///athena/index.html' };
  const caller = { ...owner, isMainFrame: true };
  const gateway = new KnowledgeGateway(knowledge, owner);
  for (const foreign of [{ ...caller, webContentsId: 2 }, { ...caller, isMainFrame: false }, { ...caller, url: 'https://example.com' }]) await expect(gateway.dispatch(foreign, 'inspect', undefined)).rejects.toThrow('Unauthorized');
  await expect(gateway.dispatch(caller, 'inspect', {})).rejects.toThrow();
  await expect(gateway.dispatch(caller, 'publish', undefined)).rejects.toThrow();
  expect(await gateway.dispatch(caller, 'inspect', undefined)).toEqual([]);
  for (const payload of [undefined, {}, { operation: 'publish' }, { operation: 'search', query: 'x', limit: 1000 }, { operation: 'search', query: 'x', sql: 'SELECT *' }]) await expect(gateway.dispatch(caller, 'retrieve', payload)).rejects.toThrow();
  await expect(gateway.dispatch({ ...caller, isMainFrame: false }, 'retrieve', { operation: 'search', query: '' })).rejects.toThrow('Unauthorized');
  expect(await gateway.dispatch(caller, 'retrieve', { operation: 'search', query: '' })).toMatchObject({ items: [], notice: expect.stringContaining('not proof of absence') });
});

test('repeated normalization validates retained dependency edges even when the model omits them', async () => {
  const observed = await evidence();
  const [dependency] = await publish([{ ...candidate(), topic: 'Serving interface', claim: 'The service interface is synchronous.', provenance: 'statically-inferred', perspective: 'current', evidenceIds: ['E1'] }], { evidence: observed.slice(0, 1) });
  const [dependent] = await publish([{ ...candidate(), relations: [{ kind: 'depends-on', target: dependency }] }], { evidence: observed.slice(1) });
  writeFileSync(join(root, 'api', 'service.ts'), 'changed implementation\n');
  expect((await knowledge.inspect()).map(record => record.validation)).toEqual(['stale', 'stale']);
  await expect(publish([candidate()], { evidence: observed.slice(1), owner: { conversationId: 'conversation-2', messageId: 'message-2' } })).rejects.toThrow('changed');
  const retained = (await knowledge.inspect()).find(record => record.id === dependent)!;
  expect(retained.owners).toHaveLength(1);
  expect(retained.relations[0].target).toBe(dependency);
});

test('repository-boundary changes invalidate unchanged source content under the old name', async () => {
  // Adding a nearer repository boundary changes ownership even if file bytes do not change.
  const nested = join(root, 'api', 'sub'); mkdirSync(nested);
  renameSync(join(root, 'api', 'service.ts'), join(nested, 'service.ts'));
  // Start from a claim citing a file below a directory that is not yet a repository.
  const result = await sources.run('read', { root, path: 'api/sub/service.ts', start: 1, end: 1 });
  const entry = result.entries[0];
  await publish([{ ...candidate(), provenance: 'statically-inferred', perspective: 'current', evidenceIds: ['E1'] }], { evidence: [{ id: 'E1', citation: entry.citation!, text: entry.text! }] });
  mkdirSync(join(nested, '.git'));
  try { expect((await knowledge.inspect()).at(-1)?.validation).toBe('stale'); }
  finally { renameSync(join(nested, 'service.ts'), join(root, 'api', 'service.ts')); rmSync(nested, { recursive: true }); }
});

test('freshness deduplication cannot hide a referenced claim with obsolete repository ownership', async () => {
  const nested = join(root, 'api', 'sub'); mkdirSync(nested);
  renameSync(join(root, 'api', 'service.ts'), join(nested, 'service.ts'));
  const read = async () => {
    const result = await sources.run('read', { root, path: 'api/sub/service.ts', start: 1, end: 1 });
    return [{ id: 'E1', citation: result.entries[0].citation!, text: result.entries[0].text! }];
  };
  try {
    const [original] = await publish([{ ...candidate(), evidenceIds: ['E1'] }], { evidence: await read() });
    mkdirSync(join(nested, '.git'));
    snapshot.repositories.push({ ...snapshot.repositories[0], name: 'sub-api', path: nested });
    try {
      await expect(publish([{ ...candidate(), scope: 'sub-api', evidenceIds: ['E1'], relations: [{ kind: 'depends-on', target: original }] }], { evidence: await read() })).rejects.toThrow('changed');
      expect(await knowledge.inspect()).toHaveLength(1);
      expect((await knowledge.inspect())[0].validation).toBe('stale');
    } finally { snapshot.repositories.pop(); }
  } finally { renameSync(join(nested, 'service.ts'), join(root, 'api', 'service.ts')); rmSync(nested, { recursive: true }); }
});

test.each(['topic', 'summary', 'claim'] as const)('whitespace-only %s is malformed, not supported knowledge', async field => {
  await expect(publish([{ ...candidate(), [field]: '   ' }])).rejects.toThrow('Malformed');
  expect(await knowledge.inspect()).toEqual([]);
});

test('a new eligible file invalidates the searched scope before commit and after publication', async () => {
  const searched = await sources.run('search', { root, path: 'api', query: 'authentication' }, undefined, undefined, true);
  expect(searched.inspectedScope).toBeDefined();
  const added = join(root, 'api', 'middleware.ts');
  let checks = 0;
  try {
    await expect(publish(undefined, { inspectedScopes: [searched.inspectedScope!], assertPublishable: () => { if (++checks === 2) writeFileSync(added, 'export function authentication() {}\n'); } })).rejects.toThrow('changed');
    expect(await knowledge.inspect()).toEqual([]);
    rmSync(added);
    await publish(undefined, { inspectedScopes: [searched.inspectedScope!] });
    writeFileSync(added, 'export function authentication() {}\n');
    expect((await knowledge.inspect())[0].validation).toBe('stale');
  } finally { rmSync(added, { force: true }); }
});

test('repository reconnection keeps name-based identity without treating paths or directory names as equivalence', async () => {
  const searched = await sources.run('search', { root, path: 'api', query: 'authentication' }, undefined, undefined, true);
  await publish(undefined, { inspectedScopes: [searched.inspectedScope!] });
  const moved = join(root, 'renamed'); renameSync(join(root, 'api'), moved);
  snapshot.repositories[0].path = moved;
  try { expect((await knowledge.inspect())[0].validation).toBe('supported'); }
  finally { renameSync(moved, join(root, 'api')); snapshot.repositories[0].path = join(root, 'api'); }
});
