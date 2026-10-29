import { exchange } from './connection-exchange';

// Parent sends only an explicitly entered key. No filesystem, repository, env or Pi auth reads.
const parent = process.parentPort;
if (!parent) throw new Error('Connection worker requires an Electron parent.');
parent.once('message', (event: { data: unknown }) => {
  const value = event.data;
  if (!value || typeof value !== 'object' || !('key' in value) || typeof value.key !== 'string' || !value.key || value.key.length > 512) {
    parent.postMessage({ status: 'failed', reason: 'provider' });
    return;
  }
  void exchange(value.key, new AbortController().signal).then(result => parent.postMessage(result), () => parent.postMessage({ status: 'failed', reason: 'provider' }));
});
