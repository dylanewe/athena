import { randomUUID } from 'node:crypto';
import type { Sources } from './sources';
import type { EnvironmentAction, EnvironmentPermission } from '../shared/environment';
import type { SourceOperation, SourceRequest, SourceResult } from '../shared/sources';

interface Permission extends EnvironmentPermission { resume?: () => void }

/** Memory-only authority for one investigation. Never accepts an agent approval. */
export class EnvironmentPermissions {
  private readonly permissions = new Map<string, Permission>();
  private expired = false;
  tainted = false;
  constructor(private readonly sources: Sources, private readonly signal: AbortSignal,
    private readonly seal: () => void, private readonly cancel: () => void, private readonly changed: () => void,
    private readonly remember: (content: string) => void) {}

  snapshot(): EnvironmentPermission[] {
    return [...this.permissions.values()].map(({ resume: _resume, ...permission }) => structuredClone(permission));
  }
  expire(): void {
    this.expired = true;
    for (const permission of this.permissions.values()) permission.resume?.();
    this.permissions.clear();
  }
  act(id: string, action: EnvironmentAction): void {
    if (typeof action !== 'string' || !['local', 'external', 'deny', 'revoke'].includes(action)) throw new Error('Invalid environment action.');
    const permission = this.permissions.get(id);
    if (!permission || this.expired || this.signal.aborted) throw new Error('Environment permission expired.');
    if (action === 'revoke') { this.expire(); this.cancel(); return; }
    if (action === 'deny') { permission.waiting = false; permission.resume?.(); this.changed(); return; }
    if (action === 'external') {
      // A failed SQLite marker commit must never release contents to the worker.
      if (!this.tainted) this.seal();
      this.tainted = true; permission.external = true; permission.waiting = false;
      permission.resume?.(); this.changed(); return;
    }
    permission.local = true;
    void this.read(permission, { root: permission.root, path: permission.path }, 'local').then(result => {
      if (!this.valid(permission, 'local')) return;
      permission.preview = result.entries.find(entry => entry.ephemeral)?.text ?? 'File unavailable or withheld by access checks.';
      this.changed();
    }).catch(() => {
      if (this.valid(permission, 'local')) { permission.preview = 'File unavailable or withheld by access checks.'; this.changed(); }
    });
    this.changed();
  }
  private valid(permission: Permission, use: 'local' | 'external'): boolean {
    return !this.expired && !this.signal.aborted && this.permissions.get(permission.id) === permission && permission[use];
  }
  private async read(permission: Permission, input: SourceRequest, use: 'local' | 'external'): Promise<SourceResult> {
    const result = await this.sources.run('read', input, this.signal, { root: permission.root, path: permission.path, valid: () => this.valid(permission, use) });
    for (const entry of result.entries) if (entry.ephemeral && entry.text !== undefined) this.remember(entry.text);
    return result;
  }
  async run(operation: SourceOperation, input: SourceRequest): Promise<SourceResult> {
    const approved = [...this.permissions.values()].find(p => p.root === input.root && p.path === input.path && this.valid(p, 'external'));
    if (operation === 'read' && approved) return this.read(approved, input, 'external');
    const result = await this.sources.run(operation, input, this.signal);
    if (this.expired || this.signal.aborted) return { ...result, entries: [], status: 'cancelled' };
    for (const entry of result.entries.filter(item => item.environment)) {
      let permission = [...this.permissions.values()].find(p => p.root === input.root && p.path === entry.path);
      if (!permission) {
        permission = { id: randomUUID(), root: input.root, path: entry.path, local: false, external: false, waiting: false };
        this.permissions.set(permission.id, permission);
      }
      if (operation === 'read' && entry.path === input.path) {
        permission.waiting = true;
        const decision = new Promise<void>(resolve => { permission.resume = resolve; });
        this.changed();
        await decision;
        permission.resume = undefined;
        if (this.valid(permission, 'external')) return this.read(permission, input, 'external');
      } else this.changed();
    }
    return result;
  }
}
