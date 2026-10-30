import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let application: ElectronApplication, page: Page, directory: string;
async function launch() {
  application = await electron.launch({ args: ['.', `--user-data-dir=${directory}`] });
  page = await application.firstWindow();
  await page.getByRole('button', { name: 'Model settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Use your ChatGPT plan' })).toBeVisible();
}
async function install(mode = 'success', workerMode = 'success') {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ format: 'jwk' });
  const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const fixture = join(directory, 'chatgpt-worker-fixture.mjs');
  writeFileSync(fixture, `
    globalThis.fetch = async (url, options) => {
      if (${JSON.stringify(workerMode)} === 'stall') return new Promise(() => {});
      if (${JSON.stringify(workerMode)} === 'crash') process.exit(1);
      if (url !== 'https://api.openai.com/v1/responses' || options.redirect !== 'error') throw new Error('Wrong transport');
      const body = JSON.parse(options.body);
      if (body.model !== 'fixture-model' || body.input.length !== 1 || body.input[0].content[0].text !== 'Reply with exactly: Athena connection OK' || body.tools || body.max_output_tokens || body.store !== false || body.stream !== true) throw new Error('Unexpected body');
      const stream = 'data: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:10,output_tokens:4,input_tokens_details:{cached_tokens:2}}}})+'\\n\\n';
      return new Response(new TextEncoder().encode(stream), {headers:${JSON.stringify(workerMode)} === 'headerless' ? {} : {'content-type':'text/event-stream'}});
    };
    await import(${JSON.stringify(pathToFileURL(resolve('dist/chatgpt.js')).href)});
  `);
  await application.evaluate(async ({ shell, utilityProcess }, data) => {
    const { sign } = process.getBuiltinModule('node:crypto');
    const nativeFetch = globalThis.fetch;
    let authorization: URL | undefined;
    const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
    const state = { urls: [] as string[], grants: [] as string[], opened: [] as string[], revocations: 0 };
    (globalThis as unknown as { chatgptFixture: typeof state }).chatgptFixture = state;
    globalThis.fetch = async (url, options) => {
      const value = String(url); state.urls.push(value);
      if (value === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [{ ...data.publicKey, kid: 'desktop-fixture', alg: 'RS256' }] });
      if (value.endsWith('/oauth/token')) {
        const body = options!.body as URLSearchParams;
        state.grants.push(body.get('grant_type')!);
        if (body.get('client_id') !== 'issued-desktop-client') throw new Error('Wrong client');
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'desktop-fixture' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'issued-desktop-client', sub: 'desktop-subject', email: 'desktop@example.test', exp: now + 3600, iat: now, nonce: authorization!.searchParams.get('nonce') })).toString('base64url');
        const id = header + '.' + payload;
        const restricted = data.mode === 'permission' && authorization!.searchParams.get('prompt') !== 'consent';
        return Response.json({ id_token: id + '.' + sign('RSA-SHA256', Buffer.from(id), data.privateKey).toString('base64url'), access_token: 'desktop-private-access', refresh_token: 'desktop-private-refresh', token_type: 'Bearer', expires_in: data.mode === 'rotate' && body.get('grant_type') === 'authorization_code' ? 1 : 3600, scope: restricted ? 'openid profile email' : scopes });
      }
      if (value === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture ChatGPT model', visibility: 'list' }] });
      if (value.endsWith('/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/revoke' });
      if (value === 'https://auth.openai.com/revoke') { state.revocations++; return new Response(null, { status: data.mode === 'revokeFailure' ? 503 : 200 }); }
      throw new Error('Unexpected external request blocked by fixture');
    };
    shell.openExternal = async url => {
      state.opened.push(url);
      if (url === 'https://chatgpt.com/settings/usage') return;
      authorization = new URL(url);
      if (authorization.origin !== 'https://auth.openai.com') throw new Error('Unexpected browser URL');
      if (data.mode === 'pending') return;
      const dest = new URL(authorization.searchParams.get('redirect_uri')!);
      dest.search = new URLSearchParams({ code: 'fixture-code', state: authorization.searchParams.get('state')!, client_id: 'issued-desktop-client' }).toString();
      const response = await nativeFetch(dest);
      await response.text();
    };
    const fork = utilityProcess.fork;
    utilityProcess.fork = (modulePath, args, options) => fork(options?.serviceName === 'Athena ChatGPT test' ? data.fixture : modulePath, args, options);
  }, { mode, privateKey, publicKey, fixture });
}
async function connect() {
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await expect(page.getByText('Signed in to ChatGPT', { exact: true })).toBeVisible();
  await expect(page.getByLabel('ChatGPT model', { exact: true })).toBeEnabled();
}
async function select() { await page.getByLabel('ChatGPT model', { exact: true }).selectOption('fixture-model'); }
async function metrics() { return application.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.name === 'Athena ChatGPT test').length); }
async function requests() { return application.evaluate(() => (globalThis as unknown as { chatgptFixture: { urls: string[]; grants: string[]; opened: string[]; revocations: number } }).chatgptFixture); }

test.beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), 'athena-chatgpt-desktop-')); await launch(); });
test.afterEach(async () => { await application?.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });

test('real loopback/JWT, protected storage, IPC and utility process complete a headerless subscription test without changing DeepSeek', async () => {
  await install('rotate', 'headerless');
  const deepseek = await page.evaluate(() => window.athena.models.snapshot());
  expect((await requests()).urls).toEqual([]);
  await expect(page.getByRole('button', { name: 'Test ChatGPT connection', exact: true })).toBeDisabled();
  await connect();
  expect((await requests()).grants).toEqual(['authorization_code', 'refresh_token']);
  expect(await metrics()).toBe(0);
  await expect(page.getByRole('button', { name: 'Test ChatGPT connection', exact: true })).toBeDisabled();
  await select();
  await page.getByRole('button', { name: 'Test ChatGPT connection', exact: true }).click();
  await expect(page.getByText(/ChatGPT subscription exchange completed/)).toBeVisible();
  await expect(page.getByText(/Reported ChatGPT tokens: 10 input · 4 output · 2 cached input/)).toBeVisible();
  expect(await page.evaluate(() => window.athena.models.snapshot())).toEqual(deepseek);
  expect(JSON.stringify(await page.evaluate(() => window.athena.chatgpt.snapshot()))).not.toContain('desktop-private');
  await expect.poll(metrics).toBe(0);
  for (const file of readdirSync(join(directory, 'state')).filter(file => file.startsWith('chatgpt.sqlite'))) expect(readFileSync(join(directory, 'state', file)).toString()).not.toMatch(/desktop-private|desktop@example|desktop-subject/);
  await page.getByRole('button', { name: 'Open ChatGPT usage settings' }).click();
  expect((await requests()).opened.at(-1)).toBe('https://chatgpt.com/settings/usage');
  await application.close(); await launch(); await install();
  expect((await requests()).urls).toEqual([]);
  const restarted = await page.evaluate(() => window.athena.chatgpt.snapshot());
  expect(restarted).toMatchObject({ account: { connected: true }, selectedModel: 'fixture-model', models: [], activity: 'idle', test: { status: 'idle' } });
  await expect(page.getByRole('button', { name: 'Test ChatGPT connection', exact: true })).toBeDisabled();
});

test('missing plan permission is distinct from sign-in and explicit reconsent enables discovery', async () => {
  await install('permission');
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(page.getByText('Signed in — plan permission missing', { exact: true })).toBeVisible();
  expect((await requests()).urls).not.toContain('https://api.openai.com/v1/models');
  await page.getByRole('button', { name: 'Enable ChatGPT plan use' }).click();
  await expect(page.getByText('Signed in to ChatGPT', { exact: true })).toBeVisible();
  await expect(page.getByLabel('ChatGPT model')).toBeEnabled();
  const last = new URL((await requests()).opened.at(-1)!);
  expect(last.searchParams.get('client_id')).toBe('issued-desktop-client');
  expect(last.searchParams.get('prompt')).toBe('consent');
  expect(last.searchParams.has('agent_name_hint')).toBe(false);
});

test('disconnect reports failed revocation, retains one registration for reconnect, then permits explicit forgetting', async () => {
  await install('revokeFailure'); await connect();
  await page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true }).click();
  await expect(page.getByText(/Remote revocation was not confirmed/)).toBeVisible();
  expect((await requests()).revocations).toBe(2);
  expect((await page.evaluate(() => window.athena.chatgpt.snapshot())).account?.connected).toBe(false);
  await page.getByRole('button', { name: 'Reconnect ChatGPT' }).click();
  await expect(page.getByText('Signed in to ChatGPT', { exact: true })).toBeVisible();
  const returning = new URL((await requests()).opened.at(-1)!);
  expect(returning.searchParams.get('client_id')).toBe('issued-desktop-client');
  expect(returning.searchParams.has('id_token_hint')).toBe(false);
  await expect(page.getByLabel('ChatGPT model')).toBeEnabled();
  await page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Forget disconnected registration' })).toBeEnabled();
  await page.getByRole('button', { name: 'Forget disconnected registration' }).click();
  expect((await page.evaluate(() => window.athena.chatgpt.snapshot())).account).toBeNull();
});

test('minimizing keeps an explicit test alive; cancellation and quit kill the utility without replay on restart', async () => {
  await install('success', 'stall'); await connect(); await select();
  await page.getByRole('button', { name: 'Test ChatGPT connection' }).click();
  await expect.poll(metrics).toBe(1);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  expect((await page.evaluate(() => window.athena.chatgpt.snapshot())).activity).toBe('test');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await page.getByRole('button', { name: 'Cancel ChatGPT operation' }).click();
  await expect.poll(metrics).toBe(0);
  expect((await page.evaluate(() => window.athena.chatgpt.snapshot())).test.status).toBe('cancelled');
  await page.getByRole('button', { name: 'Test ChatGPT connection' }).click();
  await expect.poll(metrics).toBe(1);
  await application.close(); await launch(); await install();
  expect(await metrics()).toBe(0); expect((await requests()).urls).toEqual([]);
});

test('cancelled login closes its real listener and malformed IPC cannot alter model or send content', async () => {
  await install('pending');
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(page.getByRole('button', { name: 'Cancel ChatGPT operation' })).toBeVisible();
  await expect.poll(async () => (await requests()).opened.length).toBe(1);
  const redirect = new URL((await requests()).opened[0]).searchParams.get('redirect_uri')!;
  await page.getByRole('button', { name: 'Cancel ChatGPT operation' }).click();
  await expect.poll(async () => { try { await fetch(redirect); return false; } catch { return true; } }).toBe(true);
  expect(await page.evaluate(async () => {
    try { await window.athena.chatgpt.selectModel({ id: 'x', prompt: 'private repository data' } as unknown as string); return 'accepted'; } catch { return 'rejected'; }
  })).toBe('rejected');
  expect((await requests()).urls).toEqual([]);
});
