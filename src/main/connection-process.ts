import type { ConnectionProvider, ConnectionResult } from './model-settings';
import { parseTokenUsage } from '../shared/models';

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
  if (result.status === 'failed' && (result.reason === 'authentication' || result.reason === 'usage')) return { status: 'failed', reason: result.reason };
  if (result.status === 'success') {
    const usage = parseTokenUsage(result.usage);
    if (usage) return { status: 'success', usage };
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
      worker.on('spawn', () => {
        // kill() may have returned false before Electron assigned a PID.
        if (settled) { try { worker?.kill(); } catch { /* Process already gone. */ } }
      });
      worker.on('message', value => finish(decode(value)));
      worker.on('exit', () => finish({ status: 'failed', reason: 'provider' }));
      worker.postMessage({ key });
    } catch { finish({ status: 'failed', reason: 'provider' }); }
    return { result, cancel: () => finish({ status: 'failed', reason: 'provider' }) };
  }
}
