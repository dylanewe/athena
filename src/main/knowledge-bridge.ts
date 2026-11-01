import { authorize, type Caller } from './bridge';
import type { Resolutions } from './resolutions';
import type { Knowledge } from './knowledge';
import type { KnowledgeRequest, KnowledgeResult } from '../shared/knowledge';

/** Read-only inspection. Publication is never a renderer/model command. */
export class KnowledgeGateway {
  constructor(private readonly knowledge: Knowledge, private readonly owner: { webContentsId: number; url: string }, private readonly resolutions?: Resolutions) {}
  async dispatch(caller: Caller, operation: unknown, payload: unknown): Promise<KnowledgeResult> {
    authorize(caller, this.owner);
    if (operation === 'retrieve') {
      const retrieved = await this.knowledge.retrieve(payload as KnowledgeRequest);
      const { evidence, derivation: _derivation, ...result } = this.resolutions ? await this.resolutions.attach(retrieved) : retrieved;
      // Full retained text is a main-private verification envelope, not a UI excerpt.
      return { ...result, ...(evidence ? { currentCitation: evidence.citation } : {}) };
    }
    throw new Error('Invalid knowledge request.');
  }
}
