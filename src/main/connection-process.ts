import type { ConnectionProvider, ConnectionResult } from './model-settings';
import type { TokenUsage } from '../shared/models';

export interface ConnectionWorker {
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'exit', listener: () => void): unknown;
  on(event: 'spawn', listener: () => void): unknown;
  postMessage(value: { key: string }): void;
  kill(): boolean;
}

function decode(value: unknown): ConnectionResult {
  if (!value || typeof value !== 'object') return { status: 'failed', reason: 'provider' };
  const result = value as Record<string, unknown>;
  if (result.status === 'failed' && result.reason === 'authentication') return { status: 'failed', reason: 'authentication' };
  if (result.status === 'success' && result.usage && typeof result.usage === 'object') {
    const usage = result.usage as TokenUsage;
    const { input, output, cacheRead, cacheWrite } = usage;
    if ([input, output, cacheRead, cacheWrite].every(count => Number.isSafeInteger(count) && count >= 0)) {
      return { status: 'success', usage: { input, output, cacheRead, cacheWrite } };
    }
  }
  return { status: 'failed', reason: 'provider' };
}

/** One supervised, empty-environment process per deliberate test. No response text crosses back. */
export class ConnectionProcess implements ConnectionProvider {
  constructor(private readonly spawn: () => ConnectionWorker) {}
  start(key: string): ReturnType<ConnectionProvider['start']> {
    let worker: ConnectionWorker | undefined;
    let settled = false;
    let resolve!: (result: ConnectionResult) => void;
    const result = new Promise<ConnectionResult>(done => { resolve = done; });
    const finish = (value: ConnectionResult) => {
      if (settled) return;
      settled = true;
      try { worker?.kill(); } catch { /* Raw native errors are discarded. */ }
      resolve(value);
    };
    try {
      worker = this.spawn();
      worker.on('spawn', () => { if (settled) worker?.kill(); });
      worker.on('message', value => finish(decode(value)));
      worker.on('exit', () => finish({ status: 'failed', reason: 'provider' }));
      worker.postMessage({ key });
    } catch { finish({ status: 'failed', reason: 'provider' }); }
    return { result, cancel: () => finish({ status: 'failed', reason: 'provider' }) };
  }
}
