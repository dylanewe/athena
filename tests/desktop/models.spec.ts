import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let application: ElectronApplication;
let page: Page;
let directory: string;
let fixture: string;
async function launch() {
  application = await electron.launch({ args: ['.', `--user-data-dir=${directory}`] });
  page = await application.firstWindow();
  await page.getByRole('button', { name: 'Model settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Model settings', exact: true })).toBeVisible();
}
async function scriptProvider(mode = 'success') {
  // Replace only the process's HTTP boundary. Production worker, Pi adapter and IPC stay real.
  writeFileSync(fixture, `
    globalThis.fetch = async (_url, options) => {
      if (${JSON.stringify(mode)} === 'stall') return new Promise(() => {});
      if (${JSON.stringify(mode)} === 'crash') process.exit(1);
      if (${JSON.stringify(mode)} === 'authentication') return new Response(JSON.stringify({error:{message:'Authorization: Bearer sk-desktop-script'}}), {status:401});
      const body = JSON.parse(options.body);
      if (body.messages.length !== 1 || body.messages[0].content !== 'Reply with exactly: Athena connection OK' || body.max_tokens !== 32 || body.tools || body.thinking.type !== 'disabled') throw new Error('Unexpected request');
      return new Response([
        'data: ' + JSON.stringify({id:'scripted',choices:[{index:0,delta:{role:'assistant',content:'Athena connection OK'},finish_reason:null}]}),
        'data: ' + JSON.stringify({id:'scripted',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:4,total_tokens:24}}),
        'data: [DONE]',
      ].join('\\n\\n')+'\\n\\n', {headers:{'content-type':'text/event-stream'}});
    };
    await import(${JSON.stringify(pathToFileURL(resolve('dist/connection.js')).href)});
  `);
  await application.evaluate(({ utilityProcess }, fixture) => {
    const original = utilityProcess.fork;
    utilityProcess.fork = (modulePath, args, options) => original(options?.serviceName === 'Athena connection test' ? fixture : modulePath, args, options);
  }, fixture);
}
async function saveKey() {
  await page.getByLabel('DeepSeek API key', { exact: true }).fill('sk-desktop-script');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(page.getByLabel('DeepSeek API key', { exact: true })).toHaveValue('');
  await expect(page.getByText('Key saved in macOS-protected storage.', { exact: true })).toBeVisible();
}

test.beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'athena-model-desktop-'));
  fixture = join(directory, 'scripted-worker.mjs');
  await launch();
});
test.afterEach(async () => {
  await application?.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
});

test('save a protected key, explicitly test, see usage/cost, and retain settings without paid launch work', async () => {
  await scriptProvider();
  await expect(page.getByText('deepseek-flash', { exact: true })).toBeVisible();
  await expect(page.getByText('No connection test sent.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test connection', exact: true })).toBeDisabled();
  await saveKey();
  await expect(page.getByText('No connection test sent.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('exchange succeeded');
  await expect(page.getByText('20 input · 4 output · 0 cache read · 0 cache write', { exact: true })).toBeVisible();
  await expect(page.getByText('$0.00001080', { exact: true })).toBeVisible();
  await page.getByLabel('I approve the provider permission').check();
  await page.getByRole('button', { name: 'Save provider approval', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revoke provider approval', exact: true })).toBeVisible();
  await application.close();
  await launch();
  const snapshot = await page.evaluate(() => window.athena.models.snapshot());
  expect(snapshot).toMatchObject({ credentialConfigured: true, test: { status: 'success' }, gate: { reservedUsd: 0.0003456 }, providerConsent: { text: expect.any(String) } });
  expect(JSON.stringify(snapshot)).not.toContain('sk-desktop-script');
  expect(await application.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.name === 'Athena connection test').length)).toBe(0);
  await scriptProvider();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('exchange succeeded');
  expect((await page.evaluate(() => window.athena.models.snapshot())).gate.reservedUsd).toBe(0.0006912);
  for (const file of readdirSync(join(directory, 'state')).filter(name => name.startsWith('models.sqlite'))) {
    expect(readFileSync(join(directory, 'state', file)).includes(Buffer.from('sk-desktop-script'))).toBe(false);
  }
});

test('invalid credentials are actionable without exposing raw errors or retaining the key field', async () => {
  await scriptProvider('authentication');
  const logs: string[] = [];
  page.on('console', message => logs.push(message.text()));
  await saveKey();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Replace the DeepSeek API key');
  expect(await page.locator('body').innerText()).not.toContain('sk-desktop-script');
  expect(logs.join('\n')).not.toContain('sk-desktop-script');
  await page.getByLabel('DeepSeek API key', { exact: true }).fill('invalid key');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('without spaces');
  await expect(page.getByLabel('DeepSeek API key', { exact: true })).toHaveValue('');
});

test('a stalled test can be canceled and closing a window cancels without refunding its reservation', async () => {
  await scriptProvider('stall');
  await saveKey();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Testing DeepSeek');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  expect((await page.evaluate(() => window.athena.models.snapshot())).test.status).toBe('running');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await page.getByRole('button', { name: 'Cancel connection test', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('may still incur charges');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await application.close();
  await launch();
  expect(await page.evaluate(() => window.athena.models.snapshot())).toMatchObject({ test: { status: 'cancelled' }, gate: { reservedUsd: 0.0006912 } });
});

test('a worker crash fails safely and malicious settings payloads cannot send repository content', async () => {
  await scriptProvider('crash');
  await saveKey();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Check your network');
  expect(await page.evaluate(async () => {
    try { await window.athena.models.saveKey({ key: 'repository material' } as unknown as string); return 'accepted'; }
    catch { return 'rejected'; }
  })).toBe('rejected');
  expect((await page.evaluate(() => window.athena.models.snapshot())).test.status).toBe('failed');
});
