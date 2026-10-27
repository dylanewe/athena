import type { Conversations } from './conversations';
import type { JobSupervisor } from './supervisor';
import { MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH, type Workspace } from '../shared/contracts';

/** Caller metadata is derived by main from Electron, never from a renderer payload. */
export interface Caller {
  webContentsId: number;
  isMainFrame: boolean;
  url: string;
}

export class DesktopGateway {
  constructor(
    private readonly conversations: Conversations,
    private readonly jobs: JobSupervisor,
    private readonly owner: { webContentsId: number; url: string },
  ) {}

  dispatch(caller: Caller, operation: unknown, payload: unknown): Workspace {
    if (caller.webContentsId !== this.owner.webContentsId || !caller.isMainFrame || caller.url !== this.owner.url) {
      throw new Error('Unauthorized desktop caller.');
    }
    switch (operation) {
      case 'workspace':
        noPayload(payload);
        break;
      case 'create': {
        const input = object(payload, ['title']);
        this.conversations.create(text(input.title, MAX_TITLE_LENGTH));
        break;
      }
      case 'select': {
        const input = object(payload, ['conversationId']);
        this.conversations.select(identifier(input.conversationId));
        break;
      }
      case 'send': {
        const input = object(payload, ['conversationId', 'text']);
        this.jobs.start(identifier(input.conversationId), text(input.text, MAX_MESSAGE_LENGTH));
        break;
      }
      case 'cancel':
        noPayload(payload);
        this.jobs.cancel();
        break;
      default: throw new Error('Invalid desktop request.');
    }
    return { ...this.conversations.workspace(), saveError: this.jobs.saveError };
  }
}

function invalid(): never { throw new Error('Invalid desktop request.'); }
function noPayload(value: unknown): void { if (value !== undefined) invalid(); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\u0000')) return invalid();
  return value.trim();
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return invalid();
  return value;
}
