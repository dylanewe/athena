import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inventory } from '../../src/main/inventory';
import { Sources } from '../../src/main/sources';
import { Knowledge } from '../../src/main/knowledge';
import { FOLDER_CONSENT } from '../../src/shared/inventory';
import type { KnowledgeCandidate } from '../../src/shared/knowledge';

/** Real discovery, publication, SQLite indexes and filesystem authorization. No model. */
export async function createLargeMap(directory: string) {
  const root = join(directory, 'repositories'), state = join(directory, 'state');
  mkdirSync(state, { recursive: true });
  for (let repo = 0; repo < 100; repo++) {
    const path = join(root, `repo-${String(repo).padStart(3, '0')}`);
    mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, 'services.ts'), 'export const services = [0,1,2,3,4,5,6,7,8,9]; // Explicit fixture connections, not runtime tracing.\n');
  }
  const inventory = new Inventory(join(state, 'inventory.sqlite'));
  await inventory.designate(root, FOLDER_CONSENT);
  const start = performance.now();
  await inventory.scan();
  const discoveryMs = performance.now() - start;
  const sources = new Sources(join(state, 'sources.sqlite'), inventory);
  const knowledge = new Knowledge(join(state, 'knowledge.sqlite'), sources, inventory, () => {});
  const ids: string[][] = [];
  async function populate(start: number, end: number) {
  for (let repo = start; repo < end; repo++) {
    const scope = `repo-${String(repo).padStart(3, '0')}`;
    const read = await sources.run('read', { root, path: `${scope}/services.ts`, start: 1, end: 1 });
    const evidence = [{ id: 'E1', citation: read.entries[0].citation!, text: read.entries[0].text! }];
    const publish = (candidates: KnowledgeCandidate[]) => knowledge.publish({ candidates, evidence, owner: { conversationId: 'fixture', messageId: scope }, completed: true, environmentExposed: false, signal: new AbortController().signal });
    const entities: KnowledgeCandidate[] = Array.from({ length: 10 }, (_, i) => ({ id: `C${i + 1}`, scope, topic: `Service ${repo}-${i}`, summary: `Inventory boundary ${repo}-${i}`, kind: 'entity', claim: `Service ${repo}-${i} owns a distinct source boundary.`, provenance: 'statically-inferred', perspective: 'current', evidenceIds: ['E1'], relations: [], architecture: { type: 'service' } }));
    ids[repo] = await publish(entities);
    await publish(entities.map((entity, i) => ({ ...entity, topic: `Connection ${repo}-${i}`, kind: 'relationship', claim: `Explicit fixture call ${repo}-${i}.`, architecture: { type: 'api-call', from: ids[repo][i], to: ids[repo][(i + 1) % 10], mechanism: `GET /fixture/${i}` } })));
  }
  }
  return { inventory, sources, knowledge, ids, discoveryMs, populate, close() { knowledge.close(); sources.close(); inventory.close(); } };
}
