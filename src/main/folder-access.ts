import type { Inventory } from './inventory';
import type { Conversations } from './conversations';
import type { Sources } from './sources';
import type { Knowledge } from './knowledge';
import type { Resolutions } from './resolutions';

import { PURGE_CONFIRMATION } from '../shared/inventory';

/** Revoked grants are the durable deny/journal. Cleanup spans local databases,
 * so record intent first and replay idempotent steps before opening the UI.
 * Never clear the deny, including when a deletion or checkpoint fails. */
export class FolderAccess {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly inventory: Inventory, private readonly conversations: Conversations,
    private readonly sources: Sources, private readonly knowledge: Knowledge, private readonly resolutions: Resolutions,
    private readonly stop: () => void, private readonly changed: () => void = () => {},
    private readonly discardResults: (messageIds: string[]) => void = () => {}) {}

  revoke(path: string): string[] {
    const roots = this.inventory.revoke(path); // COMMIT before cancellation/notification.
    this.stop();
    this.conversations.revoke(roots);
    this.changed();
    return roots;
  }
  purge(path: string, confirmation: string): Promise<void> {
    if (confirmation !== PURGE_CONFIRMATION) throw new Error('Destructive purge confirmation required.');
    const roots = this.revoke(path);
    this.inventory.purgeState(roots, true);
    return this.serial(() => this.remove(roots));
  }
  recover(): Promise<void> {
    const roots = this.inventory.snapshot().roots.filter(root => root.revokedAt);
    this.conversations.revoke(roots.map(root => root.path));
    const pending = roots.filter(root => root.purgePending).map(root => root.path);
    return this.serial(async () => { if (pending.length) await this.remove(pending); });
  }
  private serial(action: () => Promise<void>): Promise<void> {
    const result = this.pending.then(action); this.pending = result.catch(() => {}); return result;
  }
  private async remove(roots: string[]): Promise<void> {
    // Serial writers drain before deletion. Their final source guards reject any
    // in-flight normalization/annotation based on revoked input.
    await this.resolutions.purge(roots);
    await this.knowledge.purge(roots);
    this.discardResults(this.conversations.purge(roots));
    this.sources.purge(roots);
    this.inventory.purgeState(roots, false);
    this.changed();
  }
}
