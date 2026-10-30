import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatGPTSettings, type ChatGPTProvider } from '../../src/main/chatgpt-settings';
import { ChatGPTStore, validateRecord } from '../../src/main/chatgpt-store';
import { ChatGPTError, ISSUER, SCOPES, type OAuthProtocol, type Registration } from '../../src/main/chatgpt-protocol';
import { ChatGPTGateway } from '../../src/main/chatgpt-bridge';
import { CHATGPT_TEST_TIMEOUT, type ChatGPTResult } from '../../src/shared/chatgpt';
import type { CredentialProtection } from '../../src/main/model-settings';

let directory: string, path: string;
let settings: ChatGPTSettings;
let store: ChatGPTStore;
let protection: CredentialProtection;
let oauth: OAuthProtocol;
let provider: ChatGPTProvider;
const registration = (): Registration => ({ clientId: 'issued-client', issuer: ISSUER, subject: 'subject', email: 'person@example.test', tokens: { idToken: 'verified-id', accessToken: 'private-access', refreshToken: 'private-refresh', scopes: SCOPES, expiresAt: Date.now() + 3_600_000 } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function create() {
  store = new ChatGPTStore(path, protection);
  settings = new ChatGPTSettings(store, oauth, provider);
}
async function idle() { await expect.poll(() => settings.snapshot().activity).toBe('idle'); }
async function connected() { settings.connect(); await idle(); }
async function selected() { await connected(); settings.selectModel('model-a'); }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'athena-chatgpt-')); path = join(directory, 'chatgpt.sqlite');
  protection = { available: () => true, encrypt: value => Buffer.from(Buffer.from(value).map(n => n ^ 0xa5)), decrypt: bytes => Buffer.from(Buffer.from(bytes).map(n => n ^ 0xa5)).toString() };
  oauth = {
    login: vi.fn(async () => registration()), refresh: vi.fn(async () => registration()),
    catalog: vi.fn(async () => [{ id: 'model-a', name: 'Model A' }]), revoke: vi.fn(async () => true),
  };
  provider = { start: vi.fn(() => ({ result: Promise.resolve({ status: 'success' as const, usage: { input: 8, output: 4, cachedInput: 0 } }), cancel: vi.fn() })) };
  create();
});
afterEach(async () => { vi.useRealTimers(); await settings?.close(); rmSync(directory, { recursive: true, force: true }); });

test('single registration is encrypted, snapshots redact tokens, restart performs no network or model fallback', async () => {
  expect(oauth.login).not.toHaveBeenCalled();
  await selected();
  expect(oauth.catalog).toHaveBeenCalledOnce(); expect(provider.start).not.toHaveBeenCalled();
  expect(JSON.stringify(settings.snapshot())).not.toMatch(/private-access|private-refresh|verified-id|subject|issued-client/);
  const host = store.read()!.hostId;
  await settings.close(); create();
  expect(settings.snapshot()).toMatchObject({ account: { connected: true, planEnabled: true }, models: [], selectedModel: 'model-a' });
  expect(store.read()!.hostId).toBe(host);
  expect(oauth.refresh).not.toHaveBeenCalled(); expect(oauth.catalog).toHaveBeenCalledOnce();
  settings.test(); await idle(); expect(provider.start).not.toHaveBeenCalled();
  for (const name of readdirSync(directory)) expect(readFileSync(join(directory, name)).toString()).not.toMatch(/private-access|private-refresh|verified-id|person@example/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('model selection is explicit and disappearing models cannot be tested', async () => {
  await connected();
  settings.test(); await idle(); expect(provider.start).not.toHaveBeenCalled();
  settings.selectModel('model-a');
  settings.test(); await idle();
  expect(provider.start).toHaveBeenCalledWith('private-access', 'model-a');
  expect(settings.snapshot().test).toEqual({ status: 'success', usage: { input: 8, output: 4, cachedInput: 0 } });
  oauth.catalog = async () => [{ id: 'replacement', name: 'Replacement' }];
  settings.refreshModels(); await idle();
  expect(settings.snapshot().selectedModel).toBe('model-a');
  settings.test(); await idle();
  expect(provider.start).toHaveBeenCalledOnce();
  expect(() => settings.selectModel('invented')).toThrow('unavailable');
});

test('identity-only login stays disconnected from inference until explicit reconsent', async () => {
  oauth.login = vi.fn(async () => ({ ...registration(), tokens: { idToken: 'identity-only', scopes: ['openid', 'email', 'profile'], expiresAt: 0 } }));
  await connected();
  expect(settings.snapshot().account).toMatchObject({ connected: true, planEnabled: false });
  expect(oauth.catalog).not.toHaveBeenCalled();
  settings.refreshModels(); await idle(); expect(oauth.catalog).not.toHaveBeenCalled();
  settings.connect(true); await idle();
  expect(oauth.login).toHaveBeenLastCalledWith(expect.stringMatching(/^urn:uuid:/), expect.objectContaining({ subject: 'subject' }), true, expect.any(AbortSignal));
});

test('only one login is pending; cancelled login cannot replace credentials or start discovery', async () => {
  const pending = deferred<Registration>();
  oauth.login = () => pending.promise;
  settings.connect();
  expect(() => settings.connect()).toThrow('Finish or cancel');
  await Promise.resolve();
  settings.cancel();
  pending.resolve(registration());
  await settings.close(); create();
  expect(settings.snapshot().account).toBeNull(); expect(oauth.catalog).not.toHaveBeenCalled();
});

test('rotation persists before sending and is retained when the requesting activity is cancelled', async () => {
  await selected();
  const record = store.read()!;
  record.registration!.tokens!.expiresAt = 0; store.write(record);
  const pending = deferred<Registration>();
  oauth.refresh = vi.fn(() => pending.promise);
  settings.test();
  await expect.poll(() => vi.mocked(oauth.refresh).mock.calls.length).toBe(1);
  settings.cancel();
  pending.resolve({ ...registration(), tokens: { ...registration().tokens!, accessToken: 'rotated-access', refreshToken: 'rotated-refresh' } });
  await settings.close(); create();
  expect(store.read()!.registration!.tokens).toMatchObject({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' });
  expect(provider.start).not.toHaveBeenCalled();
});

test('disconnect serializes behind refresh, revokes the rotated token and clears local tokens even if revocation fails', async () => {
  await selected();
  const record = store.read()!; record.registration!.tokens!.expiresAt = 0; store.write(record);
  const pending = deferred<Registration>();
  oauth.refresh = vi.fn(() => pending.promise); oauth.revoke = vi.fn(async () => false);
  settings.test(); await expect.poll(() => vi.mocked(oauth.refresh).mock.calls.length).toBe(1);
  settings.disconnect();
  pending.resolve({ ...registration(), tokens: { ...registration().tokens!, refreshToken: 'latest-refresh' } });
  await idle();
  expect(oauth.revoke).toHaveBeenCalledWith(expect.objectContaining({ tokens: expect.objectContaining({ refreshToken: 'latest-refresh' }) }), expect.any(AbortSignal));
  expect(store.read()!.registration).toEqual({ clientId: 'issued-client', issuer: ISSUER, subject: 'subject', email: 'person@example.test' });
  expect(settings.snapshot().message).toContain('not confirmed');
  expect(provider.start).not.toHaveBeenCalled();
  settings.connect(); await idle();
  expect(oauth.login).toHaveBeenLastCalledWith(record.hostId, expect.objectContaining({ clientId: 'issued-client', subject: 'subject' }), false, expect.any(AbortSignal));
});

test('shutdown still clears credentials for a queued disconnect', async () => {
  await selected();
  settings.disconnect(); await settings.close(); create();
  expect(store.read()!.registration!.tokens).toBeUndefined();
});

test('forget is allowed only when disconnected, keeps host identity and cannot retain a second registration', async () => {
  await connected();
  const host = store.read()!.hostId;
  expect(() => settings.forget()).toThrow('Disconnect');
  settings.disconnect(); await idle(); settings.forget();
  expect(store.read()).toEqual({ version: 1, hostId: host });
});

test.each(['authentication', 'protocol'] as const)('unusable refresh (%s) clears tokens and requires reconnect', async reason => {
  await selected();
  const record = store.read()!; record.registration!.tokens!.expiresAt = 0; store.write(record);
  oauth.refresh = async () => { throw new ChatGPTError(reason); };
  settings.test(); await idle();
  expect(settings.snapshot().account).toMatchObject({ connected: false, reconnectRequired: true });
  expect(provider.start).not.toHaveBeenCalled();
});

test('temporary refresh failure preserves credentials without using stale authority', async () => {
  await selected();
  const record = store.read()!; record.registration!.tokens!.expiresAt = 0; store.write(record);
  oauth.refresh = async () => { throw new Error('raw bearer private-access'); };
  settings.test(); await idle();
  expect(settings.snapshot().account?.connected).toBe(true);
  expect(settings.snapshot().message).not.toContain('private-access'); expect(provider.start).not.toHaveBeenCalled();
});

test('rotation persistence failure fails closed and never sends with unpersisted credentials', async () => {
  await selected();
  const record = store.read()!; record.registration!.tokens!.expiresAt = 0; store.write(record);
  protection.encrypt = () => { throw new Error('secret'); };
  settings.test(); await idle();
  expect(settings.snapshot().protectedStorageAvailable).toBe(false);
  expect(provider.start).not.toHaveBeenCalled();
  expect(() => settings.refreshModels()).toThrow('safely');
});

test('protected storage unavailability blocks initialization without plaintext fallback', () => {
  protection.available = () => false;
  expect(settings.snapshot().protectedStorageAvailable).toBe(false);
  expect(() => settings.connect()).toThrow('safely'); expect(oauth.login).not.toHaveBeenCalled();
});

test('corrupt credential record is rejected entirely and cannot be overwritten through connect', async () => {
  await settings.close();
  const db = new DatabaseSync(path);
  db.prepare('INSERT OR REPLACE INTO credentials VALUES (1, ?)').run(protection.encrypt('{"version":1,"hostId":"bad","registration":{}}'));
  db.close(); create();
  expect(settings.snapshot().account).toBeNull();
  expect(() => settings.connect()).toThrow('safely'); expect(oauth.login).not.toHaveBeenCalled();
});

test('malformed record rejects unknown fields and API key substitution', () => {
  expect(() => validateRecord({ version: 1, hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', registration: { ...registration(), tokens: { ...registration().tokens, accessToken: 'sk-api-key' } } })).toThrow();
  expect(() => validateRecord({ version: 1, hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', registrations: [] })).toThrow();
});

test('test timeout cancels worker and ignores late success', async () => {
  await selected();
  const pending = deferred<ChatGPTResult>(); const cancel = vi.fn(() => pending.resolve({ status: 'success' }));
  provider.start = () => ({ result: pending.promise, cancel });
  vi.useFakeTimers();
  settings.test(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(CHATGPT_TEST_TIMEOUT);
  expect(cancel).toHaveBeenCalledOnce();
  expect(settings.snapshot()).toMatchObject({ activity: 'idle', test: { status: 'cancelled' }, message: expect.stringContaining('timed out') });
});

test('IPC rejects wrong owner/frame/document and arbitrary payloads; usage URL is application owned', async () => {
  const owner = { webContentsId: 9, url: 'file:///app/index.html' };
  const caller = { ...owner, isMainFrame: true };
  const open = vi.fn(async () => {});
  const gateway = new ChatGPTGateway(settings, owner, open);
  for (const changed of [{ webContentsId: 10 }, { url: 'file:///else.html' }, { isMainFrame: false }]) expect(() => gateway.dispatch({ ...caller, ...changed }, 'connect', undefined)).toThrow();
  for (const operation of ['connect', 'test', 'cancel', 'disconnect', 'forget', 'enablePlan', 'openUsage']) expect(() => gateway.dispatch(caller, operation, { prompt: 'repository secret', url: 'https://attacker.test' })).toThrow();
  expect(() => gateway.dispatch(caller, 'selectModel', { id: 'model-a', token: 'x' })).toThrow();
  expect(() => gateway.dispatch(caller, 'credentials', undefined)).toThrow();
  await gateway.dispatch(caller, 'openUsage', undefined);
  expect(open).toHaveBeenCalledWith('https://chatgpt.com/settings/usage');
  expect(oauth.login).not.toHaveBeenCalled();
});
