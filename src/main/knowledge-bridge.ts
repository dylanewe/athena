import { authorize, noPayload, type Caller } from './bridge';
import type { Knowledge } from './knowledge';
import type { KnowledgeRecord } from '../shared/knowledge';

/** Read-only inspection. Publication is never a renderer/model command. */
export class KnowledgeGateway {
  constructor(private readonly knowledge: Knowledge, private readonly owner: { webContentsId: number; url: string }) {}
  async dispatch(caller: Caller, operation: unknown, payload: unknown): Promise<KnowledgeRecord[]> {
    authorize(caller, this.owner);
    noPayload(payload);
    if (operation !== 'inspect') throw new Error('Invalid knowledge request.');
    return this.knowledge.inspect();
  }
}
