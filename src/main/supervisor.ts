import type { Conversations } from './conversations';
import { MAX_WORKER_TEXT_LENGTH, type DemoJob, type MessageStatus } from '../shared/contracts';

/** Electron utility-process transport, not an OS filesystem sandbox. */
export interface WorkerProcess {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'spawn', listener: () => void): unknown;
  postMessage(message: DemoJob): void;
  kill(): boolean;
}

function isWorkerUpdate(value: unknown): value is { type: 'progress' | 'result'; text: string } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (message.type === 'progress' || message.type === 'result') &&
    typeof message.text === 'string' && message.text.length > 0 && message.text.length <= MAX_WORKER_TEXT_LENGTH;
}

interface ActiveJob {
  job: DemoJob;
  worker?: WorkerProcess;
  deadline?: ReturnType<typeof setTimeout>;
}

export class JobSupervisor {
  private active?: ActiveJob;
  private unsaved?: { messageId: string; status: Exclude<MessageStatus, 'running'>; text: string };

  get saveError(): string | undefined {
    return this.unsaved ? 'The demonstration stopped, but its result could not be saved. Check disk space and choose Retry saving. Your question is retained.' : undefined;
  }

  constructor(
    private readonly conversations: Conversations,
    private readonly spawn: () => WorkerProcess,
    private readonly changed: () => void,
  ) {}

  start(conversationId: string | null, text: string): void {
    this.retrySaving();
    if (this.unsaved) throw new Error('The previous result must be saved before starting another demonstration.');
    if (this.active) throw new Error('A demonstration is already running.');
    const active: ActiveJob = { job: this.conversations.begin(conversationId, text) };
    this.active = active;
    active.deadline = setTimeout(() => {
      if (this.active === active) this.settle('failed', 'Demonstration timed out. Send another message to try again.');
    }, 30_000);
    try {
      active.worker = this.spawn();
      active.worker.on('spawn', () => {
        // kill() can return false before Electron has assigned a PID.
        if (this.active !== active) active.worker?.kill();
      });
      active.worker.on('message', (message) => {
        if (this.active !== active) return;
        if (!isWorkerUpdate(message)) {
          this.settle('failed', 'Demonstration failed. Send another message to try again.');
          return;
        }
        if (message.type === 'progress') {
          try {
            this.conversations.progress(active.job.messageId, message.text);
            this.changed();
          } catch {
            this.settle('failed', 'Demonstration stopped because progress could not be saved. Send another message to try again.');
          }
        } else {
          this.settle('complete', message.text);
        }
      });
      active.worker.on('exit', () => {
        if (this.active === active) this.settle('failed', 'Demonstration process stopped. Send another message to try again.');
      });
      active.worker.postMessage(active.job);
      this.changed();
    } catch {
      this.settle('failed', 'Demonstration could not start. Send another message to try again.');
    }
  }

  lifecycle(event: 'window-close' | 'quit' | 'minimize'): void {
    if (event !== 'minimize') this.cancel();
  }

  cancel(): void {
    if (this.active) this.settle('cancelled', 'Demonstration cancelled. Send another message to try again.');
    else {
      this.retrySaving();
      this.changed();
    }
  }

  private retrySaving(): void {
    if (!this.unsaved) return;
    const { messageId, status, text } = this.unsaved;
    try {
      this.conversations.finish(messageId, status, text);
      this.unsaved = undefined;
    } catch {
      // Retain the terminal result for an explicit retry. Never let a storage
      // failure escape a process event or prevent process cleanup/window close.
    }
  }

  private settle(status: Exclude<MessageStatus, 'running'>, text: string): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    clearTimeout(active.deadline);
    this.unsaved = { messageId: active.job.messageId, status, text };
    try {
      active.worker?.kill();
    } finally {
      this.retrySaving();
      this.changed();
    }
  }
}
