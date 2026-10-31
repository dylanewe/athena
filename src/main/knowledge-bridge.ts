import { authorize, type Caller } from './bridge';
import type { Knowledge } from './knowledge';
import type { KnowledgeRequest, KnowledgeResult } from '../shared/knowledge';

/** Read-only inspection. Publication is never a renderer/model command. */
export class KnowledgeGateway {
  constructor(private readonly knowledge: Knowledge, private readonly owner: { webContentsId: number; url: string }) {}
  async dispatch(caller: Caller, operation: unknown, payload: unknown): Promise<KnowledgeResult> {
    authorize(caller, this.owner);
    if (operation === 'retrieve') {
      const { evidence, derivation: _derivation, ...result } = await this.knowledge.retrieve(payload as KnowledgeRequest);
      // Full retained text is a main-private verification envelope, not a UI excerpt.
      return { ...result, ...(evidence ? { currentCitation: evidence.citation } : {}) };
    }
    throw new Error('Invalid knowledge request.');
  }
}
