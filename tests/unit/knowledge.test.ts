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
    expect(await knowledge.reusable(new AbortController().signal)).toEqual([]);
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

