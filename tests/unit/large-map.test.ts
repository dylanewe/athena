import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLargeMap } from '../fixtures/large-map';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-large-')));
let fixture: Awaited<ReturnType<typeof createLargeMap>>;
beforeAll(async () => { fixture = await createLargeMap(directory); });
// Independent setup batches stay within the unchanged default hook deadline.
for (let start = 0; start < 100; start += 10) beforeAll(async () => { await fixture.populate(start, start + 10); });
afterAll(() => { fixture?.close(); rmSync(directory, { recursive: true, force: true }); });

test('100 discovered repositories and 1000 entities stay searchable with bounded, cyclic map pages', async () => {
    expect(fixture.inventory.snapshot().repositories).toHaveLength(100);
    expect(fixture.ids.flat()).toHaveLength(1000);
    const timings: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const result = await fixture.knowledge.retrieve({ operation: 'neighborhood', scope: `repo-${String(i).padStart(3, '0')}`, depth: 1, limit: 20 });
      timings.push(performance.now() - start);
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.length).toBeLessThanOrEqual(20);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24 * 1024);
      expect(result.neighborhood?.omitted).toBe(true);
    }
    const found = await fixture.knowledge.retrieve({ operation: 'neighborhood', query: 'Service 99', depth: 0, limit: 20 });
    expect(found.items).toHaveLength(10);
    const cyclic = await fixture.knowledge.retrieve({ operation: 'neighborhood', id: fixture.ids[0][0], depth: 3, limit: 20 });
    expect(new Set(cyclic.items.map(item => item.id)).size).toBe(cyclic.items.length);
    timings.sort((a, b) => a - b);
    process.stdout.write('MAP_BENCHMARK ' + JSON.stringify({ discoveryMs: fixture.discoveryMs, pages: timings.length, medianMs: timings[10], p95Ms: timings[18], maxMs: timings[19] }) + '\n');
});

test('acceptance inventory sizes are not ingestion or permission caps', async () => {
  const root = fixture.inventory.snapshot().roots[0].path;
  mkdirSync(join(root, 'repo-100', '.git'), { recursive: true });
  writeFileSync(join(root, 'repo-100', 'extra.ts'), 'export const extra = 1001;\n');
  await fixture.inventory.scan();
  expect(fixture.inventory.snapshot().repositories).toHaveLength(101);
  const read = await fixture.sources.run('read', { root, path: 'repo-100/extra.ts', start: 1, end: 1 });
  await fixture.knowledge.publish({ candidates: [{ id: 'C1', scope: 'repo-100', topic: 'Beyond acceptance target', summary: 'Another service.', claim: 'An additional service is retained.', kind: 'entity', architecture: { type: 'service' }, provenance: 'statically-inferred', perspective: 'current', evidenceIds: ['E1'], relations: [] }], evidence: [{ id: 'E1', citation: read.entries[0].citation!, text: read.entries[0].text! }], owner: { conversationId: 'fixture', messageId: 'extra' }, completed: true, environmentExposed: false, signal: new AbortController().signal });
  expect((await fixture.knowledge.retrieve({ operation: 'neighborhood', query: 'Beyond acceptance target', depth: 0 })).items).toHaveLength(1);
});
