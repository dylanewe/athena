import { relative } from 'node:path';
import type { SourceCheckout, SourceIdentity } from '../shared/sources';
import type { Inventory } from './inventory';
import type { Sources } from './sources';

const name = (value: string) => value.normalize('NFC').toLowerCase();
const scope = (identity: SourceIdentity) => identity.repository ? `repo:${name(identity.repository.name)}` : `folder:${identity.folder}`;

/** Main-owned checkout provenance. Capture stays memory-only; guarded unexposed publication/answers may retain it. */
export class SourceCheckouts {
  constructor(private readonly sources: Sources, private readonly inventory: Pick<Inventory, 'snapshot'>) {}
  async capture(signal?: AbortSignal, identities?: SourceIdentity[]): Promise<SourceCheckout[]> {
    const snapshot = this.inventory.snapshot();
    const locations = snapshot.roots.flatMap(root => [
      { root: root.path, path: '.', repository: null as SourceIdentity['repository'] },
      ...snapshot.repositories.filter(repo => repo.presence === 'present' && (repo.path === root.path || repo.path.startsWith(root.path + '/')))
        .map(repo => ({ root: root.path, path: relative(root.path, repo.path) || '.', repository: { name: repo.name, path: relative(root.path, repo.path) || '.' } })),
    ]);
    const results: SourceCheckout[] = [];
    const seen = new Set<string>();
    for (const location of locations) {
      // A designated root that is itself a registered repository is not a second folder scope.
      if (location.repository === null && snapshot.repositories.some(repo => repo.path === location.root && repo.presence === 'present')) continue;
      const key = location.repository ? `repo:${name(location.repository.name)}` : `folder:${location.root}`;
      if (seen.has(key) || identities && !identities.some(identity => scope(identity) === key)) continue;
      seen.add(key);
      signal?.throwIfAborted();
      let result: SourceCheckout | undefined;
      try { result = await this.sources.checkout(location.root, location.path, signal); } catch { /* Fail closed. */ }
      results.push(result ?? { folder: location.root, repository: location.repository, path: location.path, revision: null, contentIdentity: '', checkout: true, complete: false });
    }
    return results;
  }
  select(identities: SourceIdentity[], snapshots: SourceCheckout[]): SourceCheckout[] {
    const scopes = new Set(identities.map(scope));
    return snapshots.filter(snapshot => scopes.has(scope(snapshot)));
  }
  covers(identities: SourceIdentity[], snapshots: SourceCheckout[]): boolean {
    return identities.every(identity => snapshots.some(snapshot => scope(snapshot) === scope(identity) && snapshot.complete));
  }
  async fresh(snapshots: SourceCheckout[], signal?: AbortSignal): Promise<boolean> {
    const unique = [...new Map(snapshots.map(snapshot => [JSON.stringify(snapshot), snapshot])).values()];
    for (const snapshot of unique) {
      signal?.throwIfAborted();
      if (!snapshot.complete) return false;
      const inventory = this.inventory.snapshot();
      const repo = snapshot.repository && inventory.repositories.find(repo => name(repo.name) === name(snapshot.repository!.name) && repo.presence === 'present');
      const root = repo ? inventory.roots.find(root => repo.path === root.path || repo.path.startsWith(root.path + '/'))?.path : snapshot.repository ? undefined : snapshot.folder;
      if (!root) return false;
      try {
        const current = await this.sources.checkout(root, repo ? relative(root, repo.path) || '.' : snapshot.path, signal);
        if (!current?.complete || scope(current) !== scope(snapshot) || current.contentIdentity !== snapshot.contentIdentity) return false;
      } catch { return false; }
    }
    return true;
  }
}
