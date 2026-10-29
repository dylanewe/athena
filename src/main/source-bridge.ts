import { authorize, noPayload, object, type Caller } from './bridge';
import type { Sources } from './sources';
import type { SourceOperation, SourceRequest } from '../shared/sources';

export function sourceRequest(operation: unknown, value: unknown): SourceRequest {
  if (!['list', 'search', 'read'].includes(operation as string) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source request.');
  const input = value as Record<string, unknown>;
  const allowed = operation === 'read' ? ['root', 'path', 'start', 'end'] : operation === 'search' ? ['root', 'path', 'query'] : ['root', 'path'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.root !== 'string' || input.root.length > 4096 || typeof input.path !== 'string') throw new Error('Invalid source request.');
  return input as unknown as SourceRequest;
}

export class SourceGateway {
  private active?: AbortController;
  constructor(private readonly sources: Sources, private readonly owner: { webContentsId: number; url: string }) {}
  cancel(): void { this.active?.abort(); }
  async dispatch(caller: Caller, operation: unknown, payload: unknown): Promise<unknown> {
    authorize(caller, this.owner);
    if (operation === 'cancel') { noPayload(payload); this.cancel(); return; }
    if (operation === 'exceptions') { noPayload(payload); return this.sources.exceptions(); }
    if (this.active) throw new Error('Wait for browsing or cancel it first.');
    if (operation === 'exception') {
      const input = object(payload, ['root', 'path', 'include']);
      if (typeof input.root !== 'string' || typeof input.path !== 'string' || typeof input.include !== 'boolean') throw new Error('Invalid source exception.');
      return this.sources.exception(input.root, input.path, input.include);
    }
    const request = sourceRequest(operation, payload);
    const active = new AbortController();
    this.active = active;
    try { return await this.sources.run(operation as SourceOperation, request, active.signal); }
    finally { if (this.active === active) this.active = undefined; }
  }
}
