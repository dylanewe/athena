import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installLiveFixture } from './live-fixture';

let application: ElectronApplication, page: Page, directory: string, pausedWorker: number | undefined;
async function launch() {
  application = await electron.launch({ args: ['.', `--user-data-dir=${directory}`] });
  page = await application.firstWindow();
  await installLiveFixture(application, directory);
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
}
async function newConversation() {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
}
async function send(text: string) { await page.getByLabel('Message', { exact: true }).fill(text); await page.getByRole('button', { name: 'Send message' }).click(); }
async function answered() { await expect(page.getByRole('log').getByText('Fixture response.', { exact: true }).last()).toBeVisible(); await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull(); }
async function investigateEnvironment(question: string, canary: string) {
  const root = join(directory, 'repo'); mkdirSync(root); writeFileSync(join(root, '.env'), 'PASSWORD=' + canary);
  await installLiveFixture(application, directory, root, true);
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.evaluate(() => window.athena.inventory.chooseFolder());
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I understand the folder permission' }).check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.inventory.snapshot()).discovery.status)).not.toBe('running');
  await newConversation(); await send(question);
}
async function pauseNextWorker() {
  await application.evaluate(({ utilityProcess }) => {
    const fork = utilityProcess.fork;
    utilityProcess.fork = (...args) => { utilityProcess.fork = fork; const child = fork(...args); child.once('spawn', () => process.kill(child.pid!, 'SIGSTOP')); return child; };
  });
}
async function workerPid() {
  let pid: number | undefined;
  await expect.poll(async () => { pid = await application.evaluate(({ app }) => app.getAppMetrics().find(metric => metric.name === 'Athena ChatGPT conversation')?.pid); return pid; }).toBeTruthy();
  return pid!;
}
function resume() { if (pausedWorker) { try { process.kill(pausedWorker, 'SIGCONT'); } catch { /* already stopped */ } pausedWorker = undefined; } }
test.beforeEach(async () => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-desktop-'))); await launch(); });
test.afterEach(async () => { resume(); await application?.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });

test('normalized knowledge opens from the answer, exposes evidence independently, survives restart and warns about staleness', async () => {
  const root = join(directory, 'repo'); mkdirSync(root); writeFileSync(join(root, 'answer.ts'), 'export const answer = 42;\n');
  await installLiveFixture(application, directory, root, false, true);
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.evaluate(() => window.athena.inventory.chooseFolder());
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I understand the folder permission' }).check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.inventory.snapshot()).discovery.status)).not.toBe('running');
  await newConversation(); await send('Explain answer ownership');
  await page.getByRole('button', { name: 'Inspect retained knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Answer ownership', exact: true })).toBeVisible();
  await expect(page.getByText('unchecked', { exact: true })).toBeVisible();
  await page.getByText('Evidence (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Read retained excerpt', exact: true }).click();
  await expect(page.locator('pre')).toContainText('export const answer = 42;');
  await page.getByRole('button', { name: 'Inspect current file', exact: true }).click();
  await expect(page.getByText('Matches retained content.', { exact: false })).toBeVisible();
  await page.getByLabel('Search knowledge', { exact: true }).fill('HTTP ingress');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No accessible indexed match in this page.', { exact: false })).toBeVisible();
  await page.getByLabel('Search knowledge', { exact: true }).fill('answer value');
  await page.getByLabel('Repository scope', { exact: true }).fill(`folder:${root}`);
  await page.getByLabel('Exact topic or alias', { exact: true }).check();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Answer ownership', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Knowledge details', exact: true }).click();
  await expect(page.getByText('Inspected-file dependencies (1)', { exact: true })).toBeVisible();
  await installLiveFixture(application, directory, root, false, false, true);
  await newConversation(); await send('Reuse existing answer knowledge');
  await expect(page.getByText('Retrieved knowledge (1)', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await expect(page.getByText('Investigation · complete', { exact: true })).toHaveCount(0);
  await page.getByText('Retrieved knowledge (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Inspect knowledge: Answer ownership', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Answer ownership', exact: true })).toBeVisible();
  await application.close(); await launch();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Answer ownership', exact: true })).toBeVisible();
  writeFileSync(join(root, 'answer.ts'), 'export const answer = 43;\n');
  await page.getByRole('button', { name: 'Check freshness', exact: true }).click();
  await expect(page.getByText('stale', { exact: true })).toBeVisible();
  await page.getByText('Originating answers (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('The answer is 42 [E1]');
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
});

test('unsent drafts stay local and unpersisted; no model or catalog request on launch', async () => {
  await newConversation();
  await expect(page.getByLabel('Conversation name')).toHaveCount(0);
  await expect(page.getByText('Send uses your ChatGPT plan or enabled credits', { exact: false })).toHaveCount(0);
  await expect(page.getByLabel('Conversation usage')).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('An unsent thought');
  await expect(page.getByRole('navigation', { name: 'Saved conversations' }).getByRole('button')).toHaveCount(0);
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: unknown }).liveFixture)).toEqual({ catalog: 0, workers: 0 });
  await application.close(); await launch();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  await expect(page.getByRole('navigation', { name: 'Saved conversations' }).getByRole('button')).toHaveCount(0);
});

test('real Pi utility conversation streams, persists, switches, and continues after restart without manual catalog refresh', async () => {
  await newConversation(); await send('What can Athena do today?'); await answered();
  await expect(page.getByRole('region', { name: 'Conversation composer' }).getByLabel('Conversation usage')).toContainText('2 model requests · 20 input · 8 output');
  await expect(page.getByRole('log')).not.toContainText('No dollar estimate');
  await newConversation();
  await expect(page.getByLabel('Conversation usage')).toHaveCount(0);
  await send('Second investigation'); await answered();
  await page.getByRole('button', { name: 'Topic: What can Athena do today?', exact: true }).click();
  await application.close(); await launch();
  await expect(page.getByRole('heading', { name: 'Topic: What can Athena do today?', exact: true })).toBeVisible();
  await expect(page.getByRole('log').getByText('Fixture response.', { exact: true })).toBeVisible();
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: unknown }).liveFixture)).toEqual({ catalog: 0, workers: 0 });
  await send('Follow up'); await answered();
  await expect(page.getByLabel('Conversation usage')).toContainText('3 model requests · 30 input · 12 output');
  await expect(page.getByRole('log')).not.toContainText('No dollar estimate');
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { catalog: number } }).liveFixture.catalog)).toBe(1);
  await page.getByRole('button', { name: 'Topic: Second investigation', exact: true }).click();
  await expect(page.getByRole('log').getByText('Follow up', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Conversation usage')).toContainText('2 model requests · 20 input · 8 output');
});

test('failed first save retains the draft and creates no empty sidebar entry', async () => {
  await newConversation(); const writer = new DatabaseSync(join(directory, 'state', 'conversations.sqlite'));
  try {
    writer.exec('BEGIN IMMEDIATE'); await send('Keep my first prompt');
    await expect(page.getByRole('alert')).toContainText('Your draft is still here');
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my first prompt');
    await expect(page.getByRole('navigation', { name: 'Saved conversations' }).getByRole('button')).toHaveCount(0);
    writer.exec('ROLLBACK'); await page.getByRole('button', { name: 'Send message' }).click(); await answered();
    await expect(page.getByRole('navigation', { name: 'Saved conversations' }).getByRole('button')).toHaveCount(1);
  } finally { writer.close(); }
});

test('draft survives navigation and another conversation finishing', async () => {
  await newConversation(); await pauseNextWorker(); await send('Saved conversation'); pausedWorker = await workerPid();
  await newConversation(); await page.getByLabel('Message', { exact: true }).fill('A future investigation'); resume();
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('A future investigation');
  await page.getByRole('button', { name: 'Topic: Saved conversation', exact: true }).click(); await answered();
  await newConversation(); await expect(page.getByLabel('Message', { exact: true })).toHaveValue('A future investigation');
  await page.getByRole('button', { name: 'Repositories', exact: true }).click(); await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('A future investigation');
});

test('worker crash exposes an explicit retry that preserves the original question once', async () => {
  await newConversation(); await pauseNextWorker(); await send('Retry this question'); pausedWorker = await workerPid();
  process.kill(pausedWorker, 'SIGKILL'); pausedWorker = undefined;
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await answered();
  await expect(page.getByRole('log').getByText('Retry this question', { exact: true })).toHaveCount(1);
});

test('minimizing keeps the live worker active', async () => {
  await newConversation(); await pauseNextWorker(); await send('Keep working'); pausedWorker = await workerPid();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  expect(await page.evaluate(async () => (await window.athena.workspace()).selected?.messages.at(-1)?.status)).toBe('running');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore()); resume(); await answered();
});

for (const action of ['close window', 'quit'] as const) test(`${action} cancels work, retaining the question without replay`, async () => {
  await newConversation(); await pauseNextWorker(); await send('Retain my question'); pausedWorker = await workerPid();
  const closed = application.waitForEvent('close');
  await application.evaluate(({ app, BrowserWindow }, action) => { if (action === 'quit') app.quit(); else BrowserWindow.getAllWindows()[0].close(); }, action);
  resume(); await closed; await launch();
  await expect(page.getByRole('log')).toContainText('Cancelled.');
  await expect(page.getByRole('log').getByText('Retain my question', { exact: true })).toBeVisible();
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
  await send('Continue after restart'); await answered();
});

test('abrupt application death marks the saved attempt interrupted, never replays it', async () => {
  await newConversation(); await pauseNextWorker(); await send('Keep the question after a crash'); pausedWorker = await workerPid();
  const closed = application.waitForEvent('close'); application.process().kill('SIGKILL'); await closed;
  try { process.kill(pausedWorker, 'SIGKILL'); } catch { /* Already gone */ } pausedWorker = undefined;
  await launch(); await expect(page.getByRole('log')).toContainText('interrupted');
  await send('A fresh job'); await answered();
});

test('storage failure still stops the worker and offers Retry saving', async () => {
  await newConversation(); await pauseNextWorker(); await send('Keep this question'); pausedWorker = await workerPid();
  const writer = new DatabaseSync(join(directory, 'state', 'conversations.sqlite'));
  try {
    writer.exec('BEGIN IMMEDIATE'); await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('result could not be saved');
    const pid = pausedWorker; resume();
    await expect.poll(() => { try { process.kill(pid!, 0); return true; } catch { return false; } }).toBe(false);
    writer.exec('ROLLBACK'); await page.getByRole('button', { name: 'Retry saving' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await send('Continue after saving'); await answered();
  } finally { writer.close(); }
});

test('read-only investigation uses global folder consent, renders evidence and blocks stale-history reuse', async () => {
  const root = join(directory, 'repo'); mkdirSync(root); writeFileSync(join(root, 'answer.ts'), 'export const answer = 42;\n');
  await installLiveFixture(application, directory, root);
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.evaluate(() => window.athena.inventory.chooseFolder());
  // Use the renderer's real consent controls, not a privileged bypass.
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I understand the folder permission' }).check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.inventory.snapshot()).discovery.status)).not.toBe('running');
  await newConversation(); await send('Inspect the answer');
  await expect(page.getByRole('log')).toContainText('The answer is 42 [E1]');
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).selected?.messages.at(-1)?.status)).toBe('complete');
  await page.getByText('Investigation · complete', { exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Inspected scope');
  await expect(page.getByRole('log')).toContainText(root + '/answer.ts');
  await expect(page.getByRole('log')).toContainText('Runtime behavior was not observed');
  await expect(page.getByRole('log')).toContainText('Candidate knowledge changes (not applied)');
  await page.getByText('Inspected evidence (1)', { exact: true }).click();
  await page.getByText('[E1] answer.ts:1–1', { exact: true }).click();
  await expect(page.getByRole('log')).toContainText('export const answer = 42;');
  writeFileSync(join(root, 'answer.ts'), 'export const answer = 43;\n');
  await page.getByRole('button', { name: 'Inspect current file' }).click();
  await expect(page.getByRole('log')).toContainText('Changed since this answer');
  await send('Explain more'); await expect(page.getByRole('log')).toContainText('Saved evidence changed');
});

test('environment permission UI separates local preview from outbound access and seals ephemeral output across restart', async () => {
  const canary = 'synthetic-desktop-env-7';
  let logs = '';
  application.process().stdout?.on('data', chunk => { logs += String(chunk); });
  application.process().stderr?.on('data', chunk => { logs += String(chunk); });
  await investigateEnvironment('Inspect actual environment', canary);
  await expect(page.getByRole('region', { name: 'Environment-file permissions' })).toBeVisible();
  expect((await page.textContent('body'))?.includes(canary)).toBe(false);
  expect(await page.evaluate(async () => {
    const id = (await window.athena.workspace()).environment![0].id;
    try { await window.athena.environment(id, ['revoke'] as never); return true; } catch { return false; }
  })).toBe(false);
  expect(await page.evaluate(async () => (await window.athena.workspace()).environment![0].local)).toBe(false);
  await page.getByRole('button', { name: 'Approve local inspection' }).click();
  await expect(page.getByLabel('Ephemeral local preview')).toContainText(canary);
  expect(await page.evaluate(async () => (await window.athena.workspace()).environment?.[0].external)).toBe(false);
  await page.getByRole('button', { name: 'Approve external processing' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await expect(page.getByRole('log')).toContainText('Ephemeral · Not saved');
  expect((await page.getByRole('log').textContent())?.includes(canary)).toBe(true);
  await expect(page.getByLabel('Message', { exact: true })).toBeDisabled();
  expect(readdirSync(join(directory, 'state')).some(file => readFileSync(join(directory, 'state', file)).includes(canary))).toBe(false);
  expect(logs.includes(canary)).toBe(false);
  await application.close(); await launch();
  expect((await page.textContent('body'))?.includes(canary)).toBe(false);
  await expect(page.getByRole('log')).toContainText('derived output was not saved');
  await expect(page.getByRole('region', { name: 'Environment-file permissions' })).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toBeDisabled();
});

test('local preview can be revoked from the UI without external permission and expires on restart', async () => {
  const canary = 'synthetic-desktop-env-7';
  await investigateEnvironment('Inspect environment locally', canary);
  await page.getByRole('button', { name: 'Approve local inspection' }).click();
  await expect(page.getByLabel('Ephemeral local preview')).toContainText(canary);
  const permissionId = await page.evaluate(async () => (await window.athena.workspace()).environment![0].id);
  await page.getByRole('button', { name: 'Revoke and stop investigation' }).click();
  await expect(page.getByRole('region', { name: 'Environment-file permissions' })).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText('cannot be recalled');
  expect((await page.getByRole('log').textContent())?.includes(canary)).toBe(false);
  await send('Explain ' + canary);
  await expect(page.getByRole('alert')).toContainText('secret checks');
  expect(readdirSync(join(directory, 'state')).some(file => readFileSync(join(directory, 'state', file)).includes(canary))).toBe(false);
  await application.close(); await launch();
  expect(await page.evaluate(async id => { try { await window.athena.environment(id, 'external'); return true; } catch { return false; } }, permissionId)).toBe(false);
  expect((await page.textContent('body'))?.includes(canary)).toBe(false);
});

test('renderer stays sandboxed with narrow bridge and rejects malformed retry requests', async () => {
  expect(await page.evaluate(() => ({ node: typeof (globalThis as Record<string, unknown>).process, require: typeof (globalThis as Record<string, unknown>).require, bridge: Object.keys(window.athena).sort() }))).toEqual({ node: 'undefined', require: 'undefined', bridge: ['apiModels','cancel','chatgpt','environment','inventory','knowledge','models','onChange','retry','select','send','sources','workspace'] });
  expect(await application.evaluate(({ app, BrowserWindow }) => app.getAppMetrics().find(metric => metric.pid === BrowserWindow.getAllWindows()[0].webContents.getOSProcessId())?.sandboxed)).toBe(true);
  for (const url of ['https://example.com', 'file:///etc/hosts']) expect(await page.evaluate(async url => { try { await fetch(url); return 'accessible'; } catch { return 'denied'; } }, url)).toBe('denied');
  expect(await page.evaluate(async () => { try { await window.athena.retry('arbitrary-path'); return 'accepted'; } catch { return 'rejected'; } })).toBe('rejected');
});

test('another real renderer cannot use owner-only conversation, source, or credential controls', async () => {
  const second = application.waitForEvent('window');
  await application.evaluate(async ({ app, BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const outsider = new BrowserWindow({ show: false, webPreferences: { preload: `${app.getAppPath()}/dist/preload.cjs`, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await outsider.loadURL(owner.webContents.getURL());
  });
  const outsider = await second;
  expect(await outsider.evaluate(async () => {
    const results = await Promise.allSettled([window.athena.knowledge.inspect(), window.athena.workspace(), window.athena.send(null, 'attack'), window.athena.retry('00000000-0000-4000-8000-000000000000'), window.athena.chatgpt.snapshot(), window.athena.chatgpt.connect(), window.athena.inventory.chooseFolder(), window.athena.models.test(), window.athena.apiModels.snapshot(), window.athena.apiModels.credential('deepseek', 'fake-attack-key'), window.athena.apiModels.importModels(), window.athena.sources.run('read', { root: '/', path: 'etc/hosts' })]);
    return results.every(result => result.status === 'rejected');
  })).toBe(true);
});
