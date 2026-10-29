import { expect, test, vi } from 'vitest';
import { SourceGateway } from '../../src/main/source-bridge';
import type { Sources } from '../../src/main/sources';

const owner = { webContentsId: 4, url: 'file:///athena/index.html' };
const caller = { ...owner, isMainFrame: true };
function fixture() {
  const service = { run: vi.fn().mockResolvedValue({ entries: [] }), exceptions: vi.fn().mockReturnValue([]), exception: vi.fn().mockResolvedValue([]) };
  return { service, gateway: new SourceGateway(service as unknown as Sources, owner) };
}

test('authorizes window/main frame/exact URL before dispatching reads or policy changes', async () => {
  const { service, gateway } = fixture();
  for (const forged of [{ ...caller, webContentsId: 8 }, { ...caller, isMainFrame: false }, { ...caller, url: 'file:///elsewhere' }]) {
    for (const operation of ['read', 'exception', 'cancel', 'exceptions']) await expect(gateway.dispatch(forged, operation, undefined)).rejects.toThrow();
  }
  expect(service.run).not.toHaveBeenCalled(); expect(service.exception).not.toHaveBeenCalled();
});

test('rejects extra capabilities and malformed payload shapes; valid requests pass only narrow parameters', async () => {
  const { service, gateway } = fixture();
  for (const [operation, payload] of [
    ['shell', { command: 'pwd' }], ['read', { root: '/x', path: 'file', command: 'cat file' }],
    ['list', { root: '/x', path: '.', query: 'ignored' }], ['search', null], ['exceptions', {}],
    ['exception', { root: '/x', path: 'file', include: 'true' }],
  ]) await expect(gateway.dispatch(caller, operation, payload)).rejects.toThrow();
  expect(service.run).not.toHaveBeenCalled();
  await gateway.dispatch(caller, 'read', { root: '/x', path: 'readme.md', start: 2, end: 3 });
  expect(service.run).toHaveBeenCalledWith('read', { root: '/x', path: 'readme.md', start: 2, end: 3 }, expect.any(AbortSignal));
});

test('cancels active reads, excludes concurrent work, and leaves subsequent browsing available', async () => {
  const { service, gateway } = fixture();
  let signal: AbortSignal | undefined;
  service.run.mockImplementation((_operation, _request, supplied) => new Promise(resolve => {
    signal = supplied;
    supplied.addEventListener('abort', () => resolve({ entries: [], status: 'cancelled' }));
  }));
  const pending = gateway.dispatch(caller, 'list', { root: '/x', path: '.' });
  await expect(gateway.dispatch(caller, 'list', { root: '/x', path: '.' })).rejects.toThrow();
  await expect(gateway.dispatch(caller, 'exception', { root: '/x', path: 'vendor', include: true })).rejects.toThrow();
  await gateway.dispatch(caller, 'cancel', undefined);
  expect(signal?.aborted).toBe(true);
  await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
  await gateway.dispatch(caller, 'exception', { root: '/x', path: 'vendor', include: true });
  expect(service.exception).toHaveBeenCalledWith('/x', 'vendor', true);
});
