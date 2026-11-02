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
async function holdNextKnowledgeDetail() {
  await application.evaluate(({ ipcMain }) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, operation: unknown, payload: unknown) => unknown;
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('athena:knowledge')!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const gate = { entered: false, release };
    (globalThis as unknown as { detailGate: typeof gate }).detailGate = gate;
    ipcMain.removeHandler('athena:knowledge');
    ipcMain.handle('athena:knowledge', async (event, operation, payload) => {
      const result = await original(event, operation, payload);
      if (payload?.operation === 'detail') {
        ipcMain.removeHandler('athena:knowledge'); ipcMain.handle('athena:knowledge', original);
        gate.entered = true; await pending;
      }
      return result;
    });
  });
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

test('repository build is an explicit paid action, persists source coverage and opens existing knowledge search', async () => {
  const root = join(directory, 'repo'); mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'answer.ts'), 'export const answer = 42;\n');
  await installLiveFixture(application, directory, root, { investigation: { question: 'Build overview', paths: ['answer.ts'], candidates: [{ id: 'C1', scope: 'repo', topic: 'Answer ownership', summary: 'Answer boundary.', kind: 'responsibility', claim: 'The module owns the answer.', provenance: 'statically-inferred', perspective: 'current', evidenceIds: ['E1'], relations: [] }], text: 'Built overview [E1].' } });
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.evaluate(() => window.athena.inventory.chooseFolder());
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I understand the folder permission' }).check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.inventory.snapshot()).discovery.status)).not.toBe('running');
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
  await page.getByLabel('Documentation starting directories for repo', { exact: true }).fill('notes');
  await page.getByRole('button', { name: 'Save documentation hints for repo', exact: true }).click();
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
  await page.getByLabel('Select repo for knowledge build', { exact: true }).check();
  await expect(page.getByRole('region', { name: 'Build or refresh knowledge' })).toContainText(root);
  await expect(page.getByRole('button', { name: 'Build/refresh knowledge', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I authorize paid model processing for this build' }).check();
  await page.getByRole('button', { name: 'Build/refresh knowledge', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await expect(page.getByRole('region', { name: 'Knowledge build coverage' })).toContainText('repo');
  await expect(page.getByRole('region', { name: 'Knowledge build coverage' })).toContainText('answer.ts');
  await page.getByRole('button', { name: 'Inspect retained knowledge', exact: true }).click();
  await expect(page.getByText('Answer ownership', { exact: true }).first()).toBeVisible();
  await application.close(); await launch();
  expect(await page.evaluate(async () => (await window.athena.workspace()).selected!.scope?.repositories.map(repo => repo.name))).toEqual(['repo']);
  await expect(page.getByRole('region', { name: 'Conversation composer' })).toContainText('Selected scope: repo');
  expect(await page.evaluate(async () => (await window.athena.workspace()).selected!.messages.at(-1)!.build?.repositories)).toEqual(['repo']);
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
});

test('parallel investigator scope/status and configurable concurrency survive restart through the real utility and bridge', async () => {
  await page.getByRole('button', { name: 'Model settings', exact: true }).click();
  await expect(page.getByLabel('Concurrent investigators', { exact: true })).toHaveValue('3');
  await page.getByLabel('Concurrent investigators', { exact: true }).selectOption('2');
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).maxInvestigators)).toBe(2);
  const root = join(directory, 'repo'); mkdirSync(root); writeFileSync(join(root, 'answer.ts'), 'export const answer = 42;\n');
  await installLiveFixture(application, directory, root, { parallel: true, mixedPublication: true });
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.evaluate(() => window.athena.inventory.chooseFolder());
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I understand the folder permission' }).check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.inventory.snapshot()).discovery.status)).not.toBe('running');
  await newConversation(); await send('Investigate four boundaries in parallel');
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await expect(page.getByText('Some knowledge retained; other task candidates were withheld.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inspect retained knowledge', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore investigation map', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open investigation flows', exact: true })).toBeVisible();
  await page.getByText('Investigator tasks (4)', { exact: true }).click();
  for (const [index, scope] of ['API', 'Worker', 'Storage', 'Handoff'].entries()) await expect(page.getByText(`T${index + 1} · ${scope} · complete`, { exact: true })).toBeVisible();
  await page.getByText('T4 · Handoff · complete', { exact: true }).click();
  await expect(page.getByText('Find the exported answer for Handoff', { exact: true })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('The value is 42');
  await page.getByText('T2 · Worker · complete', { exact: true }).click();
  const withheld = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^T2 · Worker · complete$/ }) }).last();
  await expect(withheld).toContainText('Normalization candidates · not published');
  await expect(withheld).toContainText('Proposed note for Worker');
  await withheld.getByText(`folder:${root} · Worker proposal`, { exact: true }).click();
  await expect(withheld).toContainText('depends-on · C999');
  await page.getByRole('button', { name: 'Inspect retained knowledge', exact: true }).click();
  await expect(page.getByText('API proposal', { exact: true }).first()).toBeVisible();
  await application.close(); await launch();
  expect(await page.evaluate(async () => (await window.athena.workspace()).maxInvestigators)).toBe(2);
  const tasks = await page.evaluate(async () => (await window.athena.workspace()).selected!.messages.at(-1)!.investigators);
  expect(tasks?.map(task => [task.scope, task.status])).toEqual(['API', 'Worker', 'Storage', 'Handoff'].map(scope => [scope, 'complete']));
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
});

test('dependency explorer groups progressive services, inspects connection evidence, expands neighbors and prepares unpaid follow-up drafts', async () => {
  const root = join(directory, 'repo'); mkdirSync(join(root, '.git'), { recursive: true });
  const implementation = 'export const API = serve(); export const Worker = consume("orders"); Worker.store("postgres://orders"); // Intended: GET /planned. Historically API deployed with Worker.\n';
  writeFileSync(join(root, 'answer.ts'), implementation);
  await installLiveFixture(application, directory, root, false, false, false, false, true);
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.evaluate(() => window.athena.inventory.chooseFolder());
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I understand the folder permission' }).check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.inventory.snapshot()).discovery.status)).not.toBe('running');
  await newConversation(); await send('Explore the services and concrete dependencies');
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await page.getByRole('button', { name: 'Explore investigation map', exact: true }).click();
  let map = page.getByRole('region', { name: 'Dependency neighborhood' });
  await expect(map.getByRole('region', { name: 'repo', exact: true })).toContainText('API');
  await expect(map.getByRole('region', { name: 'repo', exact: true })).toContainText('Worker');
  await expect(map.getByRole('region', { name: 'External / unresolved' })).toContainText('Orders database');
  await expect(map).toContainText('Intended — not implementation');
  await expect(page.getByRole('region', { name: 'Concrete connections' })).toContainText('Historical — not current behavior');
  await page.getByRole('button', { name: 'Reverse visual group order' }).click();
  const connection = page.getByRole('button', { name: 'data-store · Worker.store("postgres://orders")', exact: true });
  await expect(connection).toBeVisible(); await connection.click();
  await expect(page.getByRole('heading', { name: 'Worker storage', exact: true })).toBeVisible();
  await page.getByText('Evidence (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Read retained excerpt', exact: true }).click();
  await expect(page.locator('pre').first()).toContainText('Worker.store');
  await page.getByRole('button', { name: 'Inspect current file', exact: true }).click();
  await expect(page.getByText('Matches retained content.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Ask follow-up question', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(/Investigate this source-backed architectural claim.*Worker storage/s);
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(1);
  await page.getByRole('button', { name: 'Services & dependencies', exact: true }).click();
  await page.getByLabel('Traversal depth').selectOption('0');
  await page.getByRole('button', { name: 'Show neighborhood', exact: true }).click();
  await expect(connection).toHaveCount(0);
  await application.close(); await launch();
  map = page.getByRole('region', { name: 'Dependency neighborhood' });
  await page.getByRole('button', { name: 'Services & dependencies', exact: true }).click();
  await expect(map.getByRole('button', { name: 'Worker', exact: true })).toBeVisible();
  await map.getByRole('button', { name: 'Expand neighbors' }).first().click();
  expect(readFileSync(join(root, 'answer.ts'), 'utf8')).toBe(implementation);
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
});

test('contradictions show both source trails in answers and details, with durable user resolutions and explicit rebuild reconnection', async () => {
  const root = join(directory, 'repo'); mkdirSync(root);
  writeFileSync(join(root, 'README.md'), 'Use dependency B.\n');
  writeFileSync(join(root, 'answer.ts'), 'export const result = C.call();\n');
  await installLiveFixture(application, directory, root, false, false, false, true);
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.evaluate(() => window.athena.inventory.chooseFolder());
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I understand the folder permission' }).check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.inventory.snapshot()).discovery.status)).not.toBe('running');
  await newConversation(); await send('Explain the dependency discrepancy');
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  const answer = page.getByRole('region', { name: 'Contradictory claims' }).first();
  await expect(answer).toContainText('Use dependency B.');
  await expect(answer).toContainText('export const result = C.call();');
  await expect(answer).toContainText('Sources current');
  await page.getByRole('button', { name: 'Inspect retained knowledge', exact: true }).click();
  await holdNextKnowledgeDetail();
  await page.getByRole('button', { name: 'Knowledge details', exact: true }).first().click();
  await expect.poll(() => application.evaluate(() => (globalThis as unknown as { detailGate: { entered: boolean } }).detailGate.entered)).toBe(true);
  let resolutions = page.getByRole('region', { name: 'User resolutions' });
  await expect(resolutions.getByLabel('Your resolution explanation')).toHaveCount(0);
  await application.evaluate(() => (globalThis as unknown as { detailGate: { release: () => void } }).detailGate.release());
  await resolutions.getByLabel('Resolution kind', { exact: true }).selectOption('obsolete-declaration');
  await resolutions.getByLabel('Your resolution explanation').fill('B was the early plan; C is intentional.');
  await expect(resolutions.getByLabel('Your resolution explanation')).toHaveValue('B was the early plan; C is intentional.');
  await resolutions.getByRole('button', { name: 'Save user annotation', exact: true }).click();
  await expect(resolutions).toContainText('Recorded for these versions only — not verification');
  await expect(page.getByRole('region', { name: 'Contradictory claims' }).first()).toContainText('Use dependency B.');
  await installLiveFixture(application, directory, root, false, false, true, true);
  await newConversation(); await send('Reuse the retained dependency discrepancy');
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await expect(page.getByRole('button', { name: 'Inspect retained knowledge', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Contradictory claims' }).first()).toContainText('export const result = C.call();');
  await expect(page.getByRole('region', { name: 'Contradictory claims' }).first()).toContainText('Use dependency B.');
  await application.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(directory, 'state', 'knowledge.sqlite' + suffix), { force: true });
  await launch();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  resolutions = page.getByRole('region', { name: 'User resolutions' });
  await expect(resolutions).toContainText('Requires explicit reconnection');
  await installLiveFixture(application, directory, root, false, false, false, true);
  await newConversation(); await send('Inspect the discrepancy again');
  await page.getByRole('button', { name: 'Inspect retained knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Knowledge details', exact: true }).first().click();
  await resolutions.getByLabel('Show all retained annotations, including unconnected versions').check();
  await expect(resolutions).toContainText('Requires explicit reconnection');
  await resolutions.getByLabel('I reconsidered this assertion against the selected versions above').check();
  await resolutions.getByRole('button', { name: 'Reconsider and reconnect annotation', exact: true }).click();
  await expect(resolutions).toContainText('Revision 2');
  await expect(resolutions).toContainText('Recorded for these versions only — not verification');
  writeFileSync(join(root, 'answer.ts'), 'export const result = D.call();\n');
  await resolutions.getByRole('button', { name: 'Reload annotations', exact: true }).click();
  await expect(resolutions).toContainText('Requires reconsideration');
  await resolutions.getByRole('button', { name: 'Inspect original binding', exact: true }).click();
  await expect(resolutions).toContainText('Original revision:');
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('Use dependency B.\n');
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(1);
});

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
  await application.close();
  writeFileSync(join(root, 'config.json'), '{"mode":"new"}'); // Uncited configuration changes behavior even if evidence is byte-identical.
  await launch();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Answer ownership', exact: true })).toBeVisible();
  await expect(page.getByText('stale', { exact: true })).toBeVisible();
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: unknown }).liveFixture)).toEqual({ catalog: 0, workers: 0 });
  writeFileSync(join(root, 'answer.ts'), 'export const answer = 43;\n');
  await page.getByRole('button', { name: 'Check freshness', exact: true }).click();
  await expect(page.getByText('stale', { exact: true })).toBeVisible();
  await page.getByText('Originating answers (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('The answer is 42 [E1]');
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare refresh', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(/Investigate fresh sources.*stale knowledge/s);
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
  await installLiveFixture(application, directory, root, false, true);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('log')).toContainText('Investigation');
  await expect(page.getByRole('button', { name: 'Inspect retained knowledge', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Answer ownership', exact: true })).toHaveCount(2);
  await expect(page.getByText('stale', { exact: true })).toHaveCount(1);
  await expect(page.getByText('unchecked', { exact: true })).toHaveCount(1);
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
  await launch(); await expect(page.getByRole('log')).toContainText('Interrupted after restart · Partial work');
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
  const interruptedId = await page.evaluate(async () => (await window.athena.workspace()).selected!.messages.at(-1)!.id);
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await answered();
  expect(await page.evaluate(async () => (await window.athena.workspace()).selected!.messages.at(-1)!.id)).not.toBe(interruptedId);
  await expect(page.getByRole('log').getByText('Keep the question after a crash', { exact: true })).toHaveCount(1);
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

test('reopened investigation preserves historical citations and revalidates changed sources in a new follow-up job', async () => {
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
  const historical = await page.evaluate(async () => (await window.athena.workspace()).selected!.messages.at(-1)!);
  await application.close(); await launch();
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: unknown }).liveFixture)).toEqual({ catalog: 0, workers: 0 });
  await expect(page.getByRole('log')).toContainText('Historical answer · Not current verification');
  await page.getByText('Inspected evidence (1)', { exact: true }).click();
  await page.getByText('[E1] answer.ts:1–1', { exact: true }).click();
  writeFileSync(join(root, 'answer.ts'), 'export const answer = 43;\n');
  await page.getByRole('button', { name: 'Inspect current file' }).click();
  await expect(page.getByRole('log')).toContainText('Changed since this answer');
  await installLiveFixture(application, directory, root, { investigation: { question: 'Revalidate the current value', paths: ['answer.ts'], candidates: [], text: 'The current answer is 43 [E1].' } });
  await send('Explain more using current sources');
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await expect(page.getByRole('log')).toContainText('The current answer is 43 [E1].');
  await expect(page.getByRole('log')).toContainText('Historical context withheld');
  expect(await page.evaluate(async id => (await window.athena.workspace()).selected!.messages.find(message => message.id === id), historical.id)).toEqual(historical);
  rmSync(join(root, 'answer.ts'));
  await page.getByRole('button', { name: 'Inspect current file' }).first().click();
  await expect(page.getByRole('log')).toContainText('Current file is unavailable');
  await expect(page.getByRole('log')).toContainText('export const answer = 42;');
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
  expect(await page.evaluate(() => ({ node: typeof (globalThis as Record<string, unknown>).process, require: typeof (globalThis as Record<string, unknown>).require, bridge: Object.keys(window.athena).sort() }))).toEqual({ node: 'undefined', require: 'undefined', bridge: ['apiModels','build','cancel','chatgpt','environment','inventory','knowledge','models','onChange','resolutions','retry','select','send','setMaxInvestigators','sources','workspace'] });
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
    const results = await Promise.allSettled([window.athena.resolutions.read({ operation: 'list' }), window.athena.resolutions.write({ operation: 'annotate', kind: 'note', text: 'Outsider assertion', claimIds: ['K' + 'a'.repeat(64)] }), window.athena.knowledge.retrieve({ operation: 'search', query: '' }), window.athena.workspace(), window.athena.send(null, 'attack'), window.athena.retry('00000000-0000-4000-8000-000000000000'), window.athena.chatgpt.snapshot(), window.athena.chatgpt.connect(), window.athena.inventory.chooseFolder(), window.athena.models.test(), window.athena.apiModels.snapshot(), window.athena.apiModels.credential('deepseek', 'fake-attack-key'), window.athena.apiModels.importModels(), window.athena.sources.run('read', { root: '/', path: 'etc/hosts' })]);
    return results.every(result => result.status === 'rejected');
  })).toBe(true);
});
