import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSettings } from '../../src/main/model-settings';
import { ModelGateway } from '../../src/main/model-bridge';
import { PROVIDER_CONSENT } from '../../src/shared/models';

let directory: string;
let settings: ModelSettings;
let gateway: ModelGateway;
const caller = { webContentsId: 7, isMainFrame: true, url: 'file:///athena/index.html' };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'athena-model-bridge-'));
  settings = new ModelSettings(join(directory, 'model.sqlite'), {
    available: () => true, encrypt: key => Buffer.from(key), decrypt: bytes => Buffer.from(bytes).toString(),
  }, { start: () => ({ result: Promise.resolve({ status: 'success', usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } }), cancel() {} }) });
  gateway = new ModelGateway(settings, caller);
});
afterEach(() => { settings.close(); rmSync(directory, { recursive: true, force: true }); });

test('the authorized settings bridge saves credentials and exact consent without starting a test', () => {
  expect(gateway.dispatch(caller, 'saveKey', { key: 'sk-entry' }).credentialConfigured).toBe(true);
  expect(gateway.dispatch(caller, 'consent', { text: PROVIDER_CONSENT }).providerConsent?.text).toBe(PROVIDER_CONSENT);
  expect(gateway.dispatch(caller, 'snapshot', undefined).test.status).toBe('idle');
  expect(gateway.dispatch(caller, 'revokeConsent', undefined).providerConsent).toBeNull();
  expect(gateway.dispatch(caller, 'test', undefined).test.status).toBe('running');
  expect(gateway.dispatch(caller, 'cancel', undefined).test.status).toBe('cancelled');
});

test('untrusted callers and arbitrary model/context/price payloads cannot change settings or send work', () => {
  for (const untrusted of [{ ...caller, webContentsId: 8 }, { ...caller, isMainFrame: false }, { ...caller, url: 'https://example.test' }]) {
    expect(() => gateway.dispatch(untrusted, 'saveKey', { key: 'sk-entry' })).toThrow();
    expect(() => gateway.dispatch(untrusted, 'test', undefined)).toThrow();
  }
  for (const [operation, payload] of [
    ['snapshot', {}], ['saveKey', { key: 'sk-entry', extra: true }], ['saveKey', { key: {} }],
    ['saveKey', { key: 'x'.repeat(513) }], ['consent', { text: true }], ['consent', { text: 'yes' }],
    ['test', { prompt: 'private repository', model: 'other' }], ['cancel', {}], ['revokeConsent', {}],
    ['setModel', { model: 'other', price: 0 }], ['getKey', undefined],
  ]) expect(() => gateway.dispatch(caller, operation, payload)).toThrow();
  expect(settings.snapshot()).toMatchObject({ credentialConfigured: false, providerConsent: null, test: { status: 'idle' } });
});
