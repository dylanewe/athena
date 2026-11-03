import { authorize, noPayload, object, text, type Caller } from './bridge';
import type { Conversations } from './conversations';
import type { Knowledge } from './knowledge';
import { DELETE_CONVERSATION_CONFIRMATION, RESET_CONFIRMATION, type MaintenanceStatus } from '../shared/maintenance';

/** User-only local maintenance, never a worker tool or a source of model authority. */
export class MaintenanceGateway {
  private running = false;
  get busy(): boolean { return this.running; }
  constructor(private readonly conversations: Conversations, private readonly knowledge: Knowledge,
    private readonly owner: { webContentsId: number; url: string }, private readonly canMutate: () => boolean,
    private readonly changed: () => void = () => {}) {}
  private snapshot(): MaintenanceStatus {
    return { retention: this.conversations.retentionStatus(), knowledge: { ...this.knowledge.cleanupStatus(), generation: this.knowledge.generation() } };
  }
  async dispatch(caller: Caller, operation: unknown, payload: unknown): Promise<MaintenanceStatus> {
    authorize(caller, this.owner);
    let action: () => void | Promise<void>;
    switch (operation) {
      case 'snapshot': noPayload(payload); return this.snapshot();
      case 'policy': {
        const input = object(payload, ['verboseDays']);
        if (input.verboseDays !== null && typeof input.verboseDays !== 'number') throw new Error('Invalid retention policy.');
        action = () => this.conversations.setVerboseDays(input.verboseDays as number | null); break;
      }
      case 'cleanup': noPayload(payload); action = () => this.cleanup(); break;
      case 'reset': {
        const input = object(payload, ['confirmation']);
        if (input.confirmation !== RESET_CONFIRMATION) throw new Error('Explicit reset confirmation required.');
        action = () => this.knowledge.clear(); break;
      }
      case 'deleteConversation': {
        const input = object(payload, ['conversationId', 'confirmation']);
        const id = text(input.conversationId, 100);
        if (input.confirmation !== DELETE_CONVERSATION_CONFIRMATION) throw new Error('Explicit deletion confirmation required.');
        action = () => this.conversations.deleteConversation(id); break;
      }
      default: throw new Error('Invalid maintenance request.');
    }
    await this.exclusive(action);
    return this.snapshot();
  }
  /** Main's hourly idle pass uses the same exclusion and recovery as the UI. */
  async cleanupIdle(): Promise<void> {
    if (this.running || !this.canMutate()) return;
    await this.exclusive(() => this.cleanup());
  }
  private async cleanup(): Promise<void> {
    await this.knowledge.recoverCleanup();
    this.conversations.cleanupExpired();
  }
  private async exclusive(action: () => void | Promise<void>): Promise<void> {
    if (this.running || !this.canMutate()) throw new Error('Finish active work or save pending results before local maintenance.');
    this.running = true;
    try { await action(); }
    finally { this.running = false; this.changed(); }
  }
}
