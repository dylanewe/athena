import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSettings, type CredentialProtection, type ConnectionProvider } from '../../src/main/model-settings';
import { DEEPSEEK_INFO } from '../../src/main/deepseek-model';
import { CONNECTION_TIMEOUT_MS, PROVIDER_CONSENT, type ModelInfo } from '../../src/shared/models';
import { exchange } from '../../src/worker/connection-exchange';

let directory: string;
let settings: ModelSettings;
// Scripted OS credential boundary. Production uses macOS Keychain-backed safeStorage.
const protection: CredentialProtection = {
  available: () => true,
  encrypt: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)),
  decrypt: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)).toString(),
};
const provider: ConnectionProvider = { start: () => { throw new Error('No explicit test requested'); } };
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'athena-model-')); });
afterEach(() => { settings?.close(); rmSync(directory, { recursive: true, force: true }); });

test('credentials persist protected across restart without being exposed in settings', () => {
  const path = join(directory, 'models.sqlite');
  settings = new ModelSettings(path, protection, provider);
  expect(settings.snapshot().credentialConfigured).toBe(false);
  settings.saveKey('sk-private-test');
  settings.close();
  settings = new ModelSettings(path, protection, provider);
  expect(settings.snapshot()).toMatchObject({ credentialConfigured: true, model: { provider: 'deepseek', id: 'deepseek-flash' }, gate: { limitUsd: 1, reservedUsd: 0 } });
  expect(JSON.stringify(settings.snapshot())).not.toContain('sk-private-test');
});

test('an explicit test reports scripted usage and estimated cost, reserving the conservative amount durably', async () => {
  const path = join(directory, 'models.sqlite');
  const scripted: ConnectionProvider = {
    start(key) {
      expect(key).toBe('sk-private-test');
      return { result: Promise.resolve({ status: 'success', usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } }), cancel() {} };
    },
  };
  settings = new ModelSettings(path, protection, scripted);
  settings.saveKey('sk-private-test');
  expect(settings.testConnection().test.status).toBe('running');
  await expect.poll(() => settings.snapshot().test.status).toBe('success');
  expect(settings.snapshot().test).toMatchObject({ usage: { input: 10, output: 4 }, estimatedCostUsd: 0.0000078 });
  expect(settings.snapshot().gate).toMatchObject({ limitUsd: 1, reservedUsd: 0.0003456, estimateUsd: 0.0003456 });
  settings.close();
  settings = new ModelSettings(path, protection, provider);
  expect(settings.snapshot().gate.reservedUsd).toBe(0.0003456);
  expect(settings.snapshot().test.status).toBe('success');
});

test('invalid credentials are actionable and raw provider failures cannot expose keys in results or logs', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    let rejectRaw = false;
    settings = new ModelSettings(join(directory, 'models.sqlite'), protection, {
      start: () => ({ result: rejectRaw ? Promise.reject(new Error('Authorization: Bearer sk-private-test')) :
        Promise.resolve({ status: 'failed', reason: 'authentication' }), cancel() {} }),
    });
    settings.saveKey('sk-private-test');
    settings.testConnection();
    await expect.poll(() => settings.snapshot().test.status).toBe('failed');
    expect(settings.snapshot().test.message).toContain('Replace the DeepSeek API key');
    rejectRaw = true;
    settings.testConnection();
    await expect.poll(() => settings.snapshot().test.status).toBe('failed');
    expect(settings.snapshot().test.message).toContain('Check your network');
    expect(JSON.stringify([settings.snapshot(), log.mock.calls])).not.toContain('sk-private-test');
  } finally { log.mockRestore(); }
});

test.each([
  { cost: null, error: 'Pricing is missing' },
  { cost: { input: 0.3, output: 1.2, cacheWrite: 0 } as ModelInfo['cost'], error: 'Pricing is missing' },
  { cost: { input: 0.3, output: 40_000, cacheRead: 0, cacheWrite: 0 }, error: 'cannot fit' },
])('unknown or unaffordable pricing rejects before sending: $error', ({ cost, error }) => {
  let contacted = false;
  settings = new ModelSettings(join(directory, 'models.sqlite'), protection, {
    start() { contacted = true; throw new Error('Must not send'); },
  }, undefined, { ...DEEPSEEK_INFO, cost });
  settings.saveKey('sk-private-test');
  expect(() => settings.testConnection()).toThrow(error);
  expect(contacted).toBe(false);
  expect(settings.snapshot().gate.reservedUsd).toBe(0);
});

test('reservations accumulate across restart and block an otherwise affordable next request', async () => {
  const path = join(directory, 'models.sqlite');
  settings = new ModelSettings(path, protection, { start: () => ({
    result: Promise.resolve({ status: 'success', usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } }), cancel() {},
  }) }, undefined, { ...DEEPSEEK_INFO, cost: { input: 0.3, output: 18_750, cacheRead: 0, cacheWrite: 0 } });
  settings.saveKey('sk-private-test');
  settings.testConnection();
  await expect.poll(() => settings.snapshot().test.status).toBe('success');
  settings.close();
  settings = new ModelSettings(path, protection, provider);
  expect(settings.snapshot().gate.reservedUsd).toBe(0.6003072);
  expect(() => settings.testConnection()).toThrow('cannot fit');
});

test('the real pi-ai adapter sends only the fixed bounded test prompt and interprets reported usage', async () => {
  const requests: { url: string; body: unknown; authorization: string | null; redirect: unknown }[] = [];
  const scriptedFetch: typeof fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options?.body)), authorization: new Headers(options?.headers).get('authorization'), redirect: options?.redirect });
    return new Response([
      'data: ' + JSON.stringify({ id: 'scripted', choices: [{ index: 0, delta: { role: 'assistant', content: 'Athena connection OK' }, finish_reason: null }] }),
      'data: ' + JSON.stringify({ id: 'scripted', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 } } }),
      'data: [DONE]',
    ].join('\n\n') + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  settings = new ModelSettings(join(directory, 'models.sqlite'), protection, {
    start(key) {
      const controller = new AbortController();
      return { result: exchange(key, controller.signal, scriptedFetch), cancel: () => controller.abort() };
    },
  });
  settings.saveKey('sk-private-test');
  settings.testConnection();
  await expect.poll(() => settings.snapshot().test.status).toBe('success');
  expect(requests).toEqual([{
    url: 'https://api.deepseek.com/chat/completions', authorization: 'Bearer sk-private-test', redirect: 'error',
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'Reply with exactly: Athena connection OK' }],
      stream: true, stream_options: { include_usage: true }, max_tokens: 32, thinking: { type: 'disabled' } },
  }]);
  expect(settings.snapshot().test.usage).toEqual({ input: 15, output: 4, cacheRead: 5, cacheWrite: 0 });
});

test.each([
  {}, { prompt_tokens: 20 }, { prompt_tokens: 20, completion_tokens: '4' },
  { prompt_tokens: -1, completion_tokens: 4 },
  { prompt_tokens: 20, completion_tokens: 4, prompt_cache_hit_tokens: 21 },
])('incomplete or invalid raw provider usage is never reported as zero-cost success: %j', async usage => {
  settings = new ModelSettings(join(directory, 'models.sqlite'), protection, {
    start(key) {
      const controller = new AbortController();
      return { result: exchange(key, controller.signal, async () => new Response(
        'data: ' + JSON.stringify({ id: 'scripted', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage }) + '\n\n' +
        'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } },
      )), cancel: () => controller.abort() };
    },
  });
  settings.saveKey('sk-private-test');
  settings.testConnection();
  await expect.poll(() => settings.snapshot().test.status).toBe('failed');
  expect(settings.snapshot().test.message).toContain('valid token usage was not reported');
  expect(settings.snapshot().test.usage).toBeUndefined();
  expect(settings.snapshot().test.estimatedCostUsd).toBeUndefined();
  expect(settings.snapshot().gate.reservedUsd).toBe(0.0003456);
});

test('pi-ai authentication failures do not retry or echo provider error bodies to settings or logs', async () => {
  const logs = ['error', 'warn', 'log', 'info', 'debug'].map(level => vi.spyOn(console, level as 'error').mockImplementation(() => {}));
  let calls = 0;
  try {
    settings = new ModelSettings(join(directory, 'models.sqlite'), protection, {
      start(key) {
        const controller = new AbortController();
        return { result: exchange(key, controller.signal, async () => {
          calls++;
          return new Response(JSON.stringify({ error: { message: 'Authorization: Bearer sk-private-test' } }), { status: 401 });
        }), cancel: () => controller.abort() };
      },
    });
    settings.saveKey('sk-private-test');
    settings.testConnection();
    await expect.poll(() => settings.snapshot().test.status).toBe('failed');
    expect(settings.snapshot().test.message).toContain('Replace the DeepSeek API key');
    expect(calls).toBe(1);
    expect(JSON.stringify([settings.snapshot(), logs.map(log => log.mock.calls)])).not.toContain('sk-private-test');
  } finally { logs.forEach(log => log.mockRestore()); }
});

test('cancellation stops active work, ignores late results and retains its reservation after restart', async () => {
  let resolve!: (result: Awaited<ReturnType<ConnectionProvider['start']>['result']>) => void;
  let stopped = false;
  const path = join(directory, 'models.sqlite');
  settings = new ModelSettings(path, protection, { start: () => ({
    result: new Promise(done => { resolve = done; }), cancel: () => { stopped = true; },
  }) });
  settings.saveKey('sk-private-test');
  settings.testConnection();
  expect(settings.cancel().test).toMatchObject({ status: 'cancelled', message: expect.stringContaining('may still incur charges') });
  expect(stopped).toBe(true);
  resolve({ status: 'success', usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } });
  await Promise.resolve();
  expect(settings.snapshot().test.status).toBe('cancelled');
  settings.close();
  settings = new ModelSettings(path, protection, provider);
  expect(settings.snapshot().test.status).toBe('cancelled');
  expect(settings.snapshot().gate.reservedUsd).toBe(0.0003456);
});

test('a stalled test times out without refunding uncertain work', async () => {
  vi.useFakeTimers();
  try {
    let stopped = false;
    settings = new ModelSettings(join(directory, 'models.sqlite'), protection, { start: () => ({
      result: new Promise(() => {}), cancel: () => { stopped = true; },
    }) });
    settings.saveKey('sk-private-test');
    settings.testConnection();
    await vi.advanceTimersByTimeAsync(CONNECTION_TIMEOUT_MS);
    expect(settings.snapshot().test).toMatchObject({ status: 'failed', message: expect.stringContaining('timed out') });
    expect(stopped).toBe(true);
    expect(settings.snapshot().gate.reservedUsd).toBe(0.0003456);
  } finally { vi.useRealTimers(); }
});

test('provider approval is explicit, exact, independent of connection testing and retained across restart', () => {
  const path = join(directory, 'models.sqlite');
  settings = new ModelSettings(path, protection, provider);
  settings.saveKey('sk-private-test');
  expect(settings.snapshot().providerConsent).toBeNull();
  expect(() => settings.consent('yes')).toThrow();
  settings.consent(PROVIDER_CONSENT);
  settings.close();
  settings = new ModelSettings(path, protection, provider);
  expect(settings.snapshot().providerConsent).toEqual({ text: PROVIDER_CONSENT, acceptedAt: expect.any(String) });
  expect(settings.revokeConsent().providerConsent).toBeNull();
});

test('unavailable protected storage rejects keys and a missing key rejects testing without charging', () => {
  settings = new ModelSettings(join(directory, 'models.sqlite'), { ...protection, available: () => false }, provider);
  expect(() => settings.saveKey('sk-private-test')).toThrow('protected storage is unavailable');
  expect(settings.snapshot().credentialConfigured).toBe(false);
  settings.close();
  settings = new ModelSettings(join(directory, 'models.sqlite'), protection, provider);
  expect(() => settings.testConnection()).toThrow('Save a DeepSeek API key');
  expect(settings.snapshot().gate.reservedUsd).toBe(0);
});
