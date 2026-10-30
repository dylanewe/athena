import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiSettings } from '../../src/main/api-settings';
import { DEFAULT_CONFIG, parseModelConfig } from '../../src/main/pi-model-config';
import { interpolateCredential, runCredentialHelper } from '../../src/main/api-credentials';
import { ApiModelGateway, importModelsFile } from '../../src/main/api-model-bridge';
import { ModelSettings } from '../../src/main/model-settings';
import { Conversations } from '../../src/main/conversations';

const directories: string[] = [], settings: { close(): void }[] = [];
afterEach(() => { settings.splice(0).forEach(s => s.close()); directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture(helper = vi.fn(async () => 'fake-helper-key'), env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'athena-api-')); directories.push(directory);
  const protection = { available: () => true, encrypt: (value: string) => Buffer.from(Buffer.from(value).map(n => n ^ 0x55)), decrypt: (bytes: Uint8Array) => Buffer.from(bytes).map(n => n ^ 0x55).toString() };
  const reserve = vi.fn();
  const path = join(directory, 'api.sqlite');
  const service = new ApiSettings(path, protection, helper, env, reserve); settings.push(service);
  return { service, helper, reserve, directory, path, protection };
}
function approve(service: ApiSettings) { for (const d of service.snapshot().destinations) service.approveDestination(d.id, true); }
const signal = () => new AbortController().signal;
const custom = (extra = {}) => JSON.stringify({ providers: { fake: { baseUrl: 'https://fake.example/v1', api: 'openai-completions', apiKey: '$FAKE_KEY', models: [{ id: 'one', name: 'Fake one', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }, ...extra }] } } });
function selectFake(service: ApiSettings) { service.select('api-key', 'fake/one', 'fake/one'); approve(service); return service.conversationConfig(); }

describe('Athena API-key settings boundary', () => {
  it('defaults both role models to DeepSeek without selecting API-key billing or executing helpers', () => {
    const { service, helper } = fixture();
    expect(service.snapshot()).toMatchObject({ route: 'chatgpt', conversation: 'deepseek/deepseek-flash', investigator: 'deepseek/deepseek-flash', helpers: [] });
    expect(helper).not.toHaveBeenCalled();
    expect(() => service.conversationConfig()).toThrow('Approve');
  });
  it('honors Pi model replacement and partial metadata/compat/cost overrides', () => {
    const parsed = parseModelConfig(JSON.stringify({ providers: { deepseek: { baseUrl: 'https://proxy.example/v1', modelOverrides: { 'deepseek-flash': { name: 'Private Flash', cost: { output: 3 }, compat: { supportsStore: true }, samplingParams: { top_p: 0.9 } } } } } }));
    const model = parsed.find(p => p.model.id === 'deepseek-flash')!.model;
    expect(model).toMatchObject({ name: 'Private Flash', baseUrl: 'https://proxy.example/v1', cost: { input: 0.3, output: 3, cacheRead: 0.006, cacheWrite: 0 }, compat: { supportsStore: true, thinkingFormat: 'deepseek' }, samplingParams: { top_p: 0.9 } });
    expect(() => parseModelConfig(JSON.stringify({ providers: { deepseek: { models: [{ id: 'deepseek-flash' }] } } }))).toThrow();
  });
  it('pins both complete role models across edits, restart, later jobs and conversation persistence', async () => {
    const f = fixture(undefined, { FAKE_KEY: 'env-key' });
    f.service.configure(custom()); const pinned = selectFake(f.service);
    const conversations = new Conversations(join(f.directory, 'conversations.sqlite')); settings.push(conversations);
    const binding = { model: 'one', registration: '', apiKey: pinned };
    const job = conversations.beginLive(null, 'Question', binding);
    conversations.finishLive(job.messageId, { status: 'complete', text: 'Answer', history: [], requests: 1, usageComplete: false }, []);
    f.service.configure(custom({ name: 'Changed name', cost: { input: 4, output: 8, cacheRead: 1, cacheWrite: 4 } }));
    const saved = conversations.binding(job.conversationId);
    expect(saved.apiKey?.conversation.model.name).toBe('Fake one');
    await f.service.grant(saved.apiKey!, 'conversation', 100, signal());
    expect(f.reserve).toHaveBeenLastCalledWith(19_032_000); // (100*6+16384)*$1 + 1024*$2, nano-USD
    expect(f.service.conversationConfig().conversation.model.name).toBe('Changed name');
    const restarted = new ApiSettings(f.path, f.protection, f.helper, { FAKE_KEY: 'env-key' }, f.reserve); settings.push(restarted);
    expect(restarted.snapshot().conversation).toBe('fake/one');
    expect(conversations.workspace().selected).toMatchObject({ kind: 'api-key', model: 'one' });
    expect(JSON.stringify(saved)).not.toContain('env-key');
  });
  it('requires endpoint-specific consent and enforces current revocation on old pinned jobs', async () => {
    const { service } = fixture(undefined, { FAKE_KEY: 'env-key' }); service.configure(custom()); const pinned = selectFake(service);
    service.configure(custom({ baseUrl: 'https://different.example/v2' }));
    expect(() => service.conversationConfig()).toThrow('Approve');
    await expect(service.grant(pinned, 'investigator', 10, signal())).resolves.toMatchObject({ token: 'env-key' });
    const oldId = service.snapshot().destinations.find(d => d.endpoint === 'https://fake.example/v1')?.id;
    // Restore old model configuration to expose the old destination and revoke it.
    service.configure(custom()); service.approveDestination(oldId ?? service.snapshot().destinations[0]!.id, false);
    await expect(service.grant(pinned, 'conversation', 10, signal())).rejects.toThrow('Approve');
  });
  it('preserves credential precedence, interpolation, literal semantics and protected persistence', async () => {
    const f = fixture(undefined, { FAKE_KEY: 'env-secret', DEEPSEEK_API_KEY: 'deepseek-env' });
    approve(f.service);
    await expect(f.service.grant(f.service.conversationConfig(), 'conversation', 10, signal())).resolves.toMatchObject({ token: 'deepseek-env' });
    f.service.configure(custom()); const pinned = selectFake(f.service);
    await expect(f.service.grant(pinned, 'conversation', 10, signal())).resolves.toMatchObject({ token: 'env-secret' });
    f.service.credential('fake', 'literal-ui-secret');
    await expect(f.service.grant(pinned, 'conversation', 10, signal())).resolves.toMatchObject({ token: 'literal-ui-secret' });
    expect(readFileSync(f.path).includes(Buffer.from('literal-ui-secret'))).toBe(false);
    expect(JSON.stringify(f.service.snapshot())).not.toContain('literal-ui-secret');
    f.service.revokeCredential('fake');
    await expect(f.service.grant(pinned, 'conversation', 10, signal())).rejects.toThrow('revoked');
    f.service.credential('fake', 'pre-${FAKE_KEY}-$$-$!');
    await expect(f.service.grant(pinned, 'conversation', 10, signal())).resolves.toMatchObject({ token: 'pre-env-secret-$-!' });
    expect(interpolateCredential('FAKE_KEY', { FAKE_KEY: 'not-this' })).toBe('FAKE_KEY');
    expect(() => interpolateCredential('$MISSING', {})).toThrow('unset');
  });
  it('delegates built-in API-key environment semantics to Pi, including regional providers', async () => {
    const f = fixture(undefined, { MOONSHOT_API_KEY: 'fake-regional-key', ANTHROPIC_OAUTH_TOKEN: 'not-an-api-key' });
    f.service.configure(JSON.stringify({ providers: { 'moonshotai-cn': { baseUrl: 'https://api.moonshot.cn/v1' } } }));
    const ref = f.service.snapshot().models[0]!.ref;
    f.service.select('api-key', ref, ref); approve(f.service);
    await expect(f.service.grant(f.service.conversationConfig(), 'conversation', 10, signal())).resolves.toMatchObject({ token: 'fake-regional-key' });
    f.service.configure(JSON.stringify({ providers: { anthropic: { baseUrl: 'https://api.anthropic.com' } } }));
    const anthropicRef = f.service.snapshot().models[0]!.ref;
    f.service.select('api-key', anthropicRef, anthropicRef); approve(f.service);
    await expect(f.service.grant(f.service.conversationConfig(), 'conversation', 10, signal())).rejects.toThrow('No API key resolved');
  });
  it('approves exact helpers before execution, reruns models helpers, caches stored helpers and blocks changed commands', async () => {
    const { service, helper, reserve } = fixture();
    const json = custom().replace('$FAKE_KEY', '!secret-manager first'); service.configure(json); const pinned = selectFake(service);
    await expect(service.grant(pinned, 'conversation', 10, signal())).rejects.toThrow('Approve this exact');
    expect(helper).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    service.approveHelper(service.snapshot().helpers[0]!.id, true);
    await service.grant(pinned, 'conversation', 10, signal()); await service.grant(pinned, 'investigator', 10, signal());
    expect(helper).toHaveBeenCalledTimes(2);
    service.credential('fake', '!secret-manager second');
    await expect(service.grant(pinned, 'conversation', 10, signal())).rejects.toThrow('Approve this exact');
    service.approveHelper(service.snapshot().helpers.find(h => h.command.endsWith('second'))!.id, true);
    await service.grant(pinned, 'conversation', 10, signal()); await service.grant(pinned, 'conversation', 10, signal());
    expect(helper).toHaveBeenCalledTimes(3);
  });
  it('cancels helpers, rechecks revocation during resolution, and never forwards secret errors', async () => {
    let finish!: (value: string) => void;
    const f = fixture(vi.fn(() => new Promise<string>(resolve => { finish = resolve; })));
    f.service.configure(custom().replace('$FAKE_KEY', '!delayed')); const pinned = selectFake(f.service);
    f.service.approveHelper(f.service.snapshot().helpers[0]!.id, true);
    const controller = new AbortController();
    const pending = f.service.grant(pinned, 'conversation', 10, controller.signal);
    controller.abort(); finish('secret-output');
    await expect(pending).rejects.toThrow(); expect(f.reserve).not.toHaveBeenCalled();
    const next = f.service.grant(pinned, 'conversation', 10, signal());
    f.service.revokeCredential('fake'); finish('secret-output');
    await expect(next).rejects.toThrow('revoked'); expect(f.reserve).not.toHaveBeenCalled();
    f.service.credential('fake', '!throws'); f.service.approveHelper(f.service.snapshot().helpers.find(h => h.command === 'throws')!.id, true);
    f.helper.mockRejectedValueOnce(new Error('sensitive-token-from-helper'));
    await expect(f.service.grant(pinned, 'conversation', 10, signal())).rejects.toThrow('No secret output');
  });
  it('imports only a picker-selected models file; no auth, project instructions, environment files or automatic reload', async () => {
    const f = fixture(undefined, {});
    const pi = join(f.directory, '.pi', 'agent'); mkdirSync(pi, { recursive: true });
    const path = join(pi, 'models.json'); writeFileSync(path, custom());
    writeFileSync(join(pi, 'auth.json'), '{"fake":{"type":"oauth","access":"never-import"}}');
    writeFileSync(join(pi, 'settings.json'), '{"extensions":["evil"]}');
    writeFileSync(join(f.directory, '.env'), 'FAKE_KEY=never-load');
    const picker = vi.fn(async () => path), owner = { webContentsId: 4, url: 'file:///ui' }, caller = { ...owner, isMainFrame: true };
    const gateway = new ApiModelGateway(f.service, owner, picker);
    await expect(gateway.dispatch({ ...caller, isMainFrame: false }, 'importModels', undefined)).rejects.toThrow();
    expect(picker).not.toHaveBeenCalled();
    await expect(importModelsFile(path, [f.directory])).rejects.toThrow('Repository-local');
    const projectConfig = join(f.directory, '.pi', 'models.json'); writeFileSync(projectConfig, custom());
    await expect(importModelsFile(projectConfig)).rejects.toThrow('Repository-local');
    await gateway.dispatch(caller, 'importModels', undefined);
    const pinned = selectFake(f.service); writeFileSync(path, 'invalid changed Pi globals');
    await expect(f.service.grant(pinned, 'conversation', 10, signal())).rejects.toThrow('unset');
    expect(f.service.snapshot().models[0]!.name).toBe('Fake one'); expect(f.helper).not.toHaveBeenCalled();
    await expect(gateway.dispatch(caller, 'importModels', { path })).rejects.toThrow();
  });
  it('uses the existing persistent $1 gate for paid jobs without refunds or hidden replenishment', async () => {
    const f = fixture(undefined, { FAKE_KEY: 'fake' });
    const gate = new ModelSettings(join(f.directory, 'gate.sqlite'), f.protection, { start: () => { throw new Error('not sent'); } }); settings.push(gate);
    const service = new ApiSettings(join(f.directory, 'paid.sqlite'), f.protection, f.helper, { FAKE_KEY: 'fake' }, nano => gate.reservePaidRequest(nano)); settings.push(service);
    service.configure(custom()); const pinned = selectFake(service);
    await service.grant(pinned, 'conversation', 100, signal());
    expect(gate.snapshot().gate.reservedUsd).toBe(0.019032);
    await expect(service.grant(pinned, 'conversation', 2 * 1024 * 1024, signal())).rejects.toThrow('cannot fit');
    expect(gate.snapshot().gate.reservedUsd).toBe(0.019032);
  });
  it.each([
    '{bad', '{"providers":{},"requiredNewFeature":true}', custom({ cost: undefined }), custom({ cost: { input: 0 } }),
    custom({ compat: { unknownRequiredCapability: true } }), custom({ api: 'unknown-api' }), custom({ maxTokens: 0 }),
    custom({ samplingParams: { max_tokens: 999999 } }), custom({ samplingParams: { n: 20 } }), custom({ samplingParams: { best_of: 20 } }),
    custom({ baseUrl: 'http://localhost:8000' }), custom({ baseUrl: 'https://192.168.1.10/v1' }), custom({ baseUrl: 'https://10.0.0.1/v1' }), custom({ baseUrl: 'https://172.16.0.1/v1' }), custom({ baseUrl: 'https://169.254.169.254/v1' }), custom({ baseUrl: 'https://2130706433/v1' }), custom({ baseUrl: 'https://[::1]/v1' }),
    '{"providers":{"deepseek":{"modelOverrides":{"unknown":{"name":"ignored?"}}}}}',
  ])('rejects invalid/unsupported configuration without mutating existing state: %s', json => {
    const { service } = fixture(); const before = service.snapshot();
    expect(() => service.configure(json)).toThrow(); expect(service.snapshot()).toEqual(before);
  });
});

it('bounds real trusted helpers, supports cancellation and redacts stderr', async () => {
  const f = fixture(); const helper = runCredentialHelper(f.directory, {});
  await expect(helper('printf fake-key', signal())).resolves.toBe('fake-key');
  await expect(helper('printf secret-stderr >&2; exit 1', signal())).rejects.not.toThrow('secret-stderr');
  const controller = new AbortController(); const pending = helper('sleep 60', controller.signal); controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  await expect(helper("head -c 9000 /dev/zero", signal())).rejects.toThrow('oversized');
});
