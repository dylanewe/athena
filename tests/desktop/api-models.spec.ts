import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let app: ElectronApplication, page: Page, directory: string;
async function launch() { app = await electron.launch({ args: ['.', `--user-data-dir=${directory}`] }); page = await app.firstWindow(); }
async function modelSettings() { await page.getByRole('button', { name: 'Model settings', exact: true }).click(); }
async function scriptWorker() {
  const fixture = join(directory, 'api-worker.mjs');
  writeFileSync(fixture, `globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url !== 'https://api.deepseek.com/chat/completions' || body.model !== 'deepseek-flash' || body.max_tokens !== 1024 || body.thinking.type !== 'disabled') throw new Error('Wrong pinned request');
    return new Response([
      {id:'fixture', choices:[{index:0, delta:{role:'assistant',content:'API-key answer from pinned DeepSeek'},finish_reason:null}]},
      {id:'fixture', choices:[{index:0, delta:{},finish_reason:'stop'}], usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}}
    ].map(v => 'data: '+JSON.stringify(v)+'\\n\\n').join('')+'data: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
  }; await import(${JSON.stringify(pathToFileURL(resolve('dist/live.js')).href)});`);
  await app.evaluate(({ utilityProcess }, fixture) => { const fork = utilityProcess.fork; utilityProcess.fork = (path, args, options) => fork(options?.serviceName === 'Athena ChatGPT conversation' ? fixture : path, args, options); }, fixture);
}
test.beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), 'athena-api-desktop-')); await launch(); });
test.afterEach(async () => { await app?.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });

test('explicit API-key routing, endpoint approval, protected entry, real worker, restart pinning and revocation', async () => {
  await modelSettings();
  let section = page.getByRole('region', { name: 'API-key conversation configuration' });
  await expect(section.getByRole('combobox', { name: 'Conversation model', exact: true })).toHaveValue('deepseek/deepseek-flash');
  await expect(section.getByRole('combobox', { name: 'Investigator model', exact: true })).toHaveValue('deepseek/deepseek-flash');
  await section.getByLabel('Route for new conversations').selectOption('api-key');
  await section.getByRole('button', { name: 'Save route and role models' }).click();
  await section.getByLabel('Credential source', { exact: true }).fill('fake-desktop-api-key');
  await section.getByRole('button', { name: 'Save protected credential', exact: true }).click();
  await expect(section.getByLabel('Credential source', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('A normal API-key question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Approve the exact');
  await modelSettings();
  await section.getByRole('button', { name: 'Approve repository sending', exact: true }).first().click();
  await scriptWorker();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('API-key answer from pinned DeepSeek', { exact: true })).toBeVisible();
  const workspace = await page.evaluate(() => window.athena.workspace());
  expect(workspace.selected).toMatchObject({ kind: 'api-key', model: 'deepseek-flash' });
  expect((await page.evaluate(() => window.athena.models.snapshot())).gate.reservedUsd).toBeGreaterThan(0);
  await app.close();
  expect(readFileSync(join(directory, 'state', 'api-models.sqlite')).includes(Buffer.from('fake-desktop-api-key'))).toBe(false);
  expect(readFileSync(join(directory, 'state', 'conversations.sqlite')).includes(Buffer.from('fake-desktop-api-key'))).toBe(false);
  await launch(); await modelSettings(); section = page.getByRole('region', { name: 'API-key conversation configuration' });
  await section.getByLabel('Route for new conversations').selectOption('chatgpt'); await section.getByRole('button', { name: 'Save route and role models' }).click();
  await section.getByRole('button', { name: 'Revoke deepseek credentials', exact: true }).click();
  await page.getByRole('button', { name: 'A normal API-key question', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('Follow up stays pinned'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('revoked');
  expect((await page.evaluate(() => window.athena.workspace())).selected!.messages.filter(m => m.role === 'user')).toHaveLength(1);
});

test('explicit one-time import isolates Pi resources and rejects invalid capabilities without secret echo', async () => {
  const path = join(directory, 'models.json');
  writeFileSync(path, JSON.stringify({ providers: { deepseek: { apiKey: '!printf fake-helper', modelOverrides: { 'deepseek-flash': { name: 'Imported Flash', cost: { output: 2.5 } } } } } }));
  writeFileSync(join(directory, 'auth.json'), '{"deepseek":{"type":"oauth","access":"never-read"}}');
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
  await modelSettings(); let section = page.getByRole('region', { name: 'API-key conversation configuration' });
  await section.getByText('Import or replace Pi-compatible model configuration', { exact: true }).click();
  await section.getByRole('button', { name: 'Import trusted models.json…' }).click();
  await expect(section.getByRole('combobox', { name: 'Conversation model', exact: true })).toContainText('Imported Flash');
  await expect(section.getByRole('button', { name: 'Approve exact helper' })).toBeVisible();
  writeFileSync(path, 'changed outside Athena');
  await app.close(); await launch(); await modelSettings(); section = page.getByRole('region', { name: 'API-key conversation configuration' });
  await expect(section.getByRole('combobox', { name: 'Conversation model', exact: true })).toContainText('Imported Flash');
  await section.getByText('Import or replace Pi-compatible model configuration', { exact: true }).click();
  await section.getByLabel('Pi models.json (replace configuration)').fill('{"providers":{"deepseek":{"apiKey":"secret-invalid-input","compat":{"unknownRequiredCapability":true}}}}');
  await section.getByRole('button', { name: 'Validate and save configuration' }).click();
  await expect(section.getByRole('alert')).toContainText('unknown fields are rejected');
  await expect(section.getByLabel('Pi models.json (replace configuration)')).toHaveValue('');
  expect(await page.locator('body').innerText()).not.toContain('secret-invalid-input');
});
