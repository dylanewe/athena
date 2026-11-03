import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLiveFixture } from './live-fixture';

let application: ElectronApplication, page: Page, directory: string, root: string;
async function launch() {
  application = await electron.launch({ args: ['.', `--user-data-dir=${directory}`] });
  page = await application.firstWindow(); await installLiveFixture(application, directory);
  await expect(page.getByRole('button', { name: 'Local data', exact: true })).toBeVisible();
}
async function workers() { return application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers); }
async function investigate() {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Explain the dependency discrepancy');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await expect(page.getByRole('button', { name: 'Inspect retained knowledge', exact: true })).toBeVisible();
}
test.beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-local-data-'))); root = join(directory, 'repo'); mkdirSync(root);
  writeFileSync(join(root, 'README.md'), 'Use dependency B.\n'); writeFileSync(join(root, 'answer.ts'), 'export const result = C.call();\n');
  await launch(); await installLiveFixture(application, directory, root, false, false, false, true);
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.evaluate(() => window.athena.inventory.chooseFolder());
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I understand the folder permission' }).check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.inventory.snapshot()).discovery.status)).not.toBe('running');
  await investigate();
});
test.afterEach(async () => { await application?.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });

test('local reset preserves answers, permissions and user resolutions, starts no work, and requires explicit reconnection after fresh extraction', async () => {
  const before = await page.evaluate(async () => ({ workspace: await window.athena.workspace(), folders: await window.athena.inventory.snapshot(), providers: await window.athena.apiModels.snapshot() }));
  await page.getByRole('button', { name: 'Inspect retained knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Knowledge details', exact: true }).first().click();
  let resolutions = page.getByRole('region', { name: 'User resolutions' });
  await resolutions.getByLabel('Your resolution explanation').fill('C is intentional; B was the old plan.');
  await resolutions.getByRole('button', { name: 'Save user annotation', exact: true }).click();
  await expect(resolutions).toContainText('Recorded for these versions only');
  await page.getByRole('button', { name: 'Local data', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset knowledge cache', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Reset knowledge cache' })).toContainText('paid reinvestigation');
  await page.getByLabel('I understand that reset clears derived knowledge, not my saved answers or annotations').check();
  await page.getByRole('button', { name: 'Reset knowledge cache', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No model work started');
  expect(await workers()).toBe(1);
  expect(await page.evaluate(async () => ({ workspace: await window.athena.workspace(), folders: await window.athena.inventory.snapshot(), providers: await window.athena.apiModels.snapshot() }))).toEqual(before);
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(resolutions).toContainText('Requires explicit reconnection');
  await expect(page.getByRole('button', { name: 'Knowledge details', exact: true })).toHaveCount(0);
  await application.close(); await launch(); expect(await workers()).toBe(0);
  expect(await page.evaluate(async () => (await window.athena.knowledge.retrieve({ operation: 'search', query: '' })).items)).toEqual([]);
  await installLiveFixture(application, directory, root, false, false, false, true); await investigate();
  resolutions = page.getByRole('region', { name: 'User resolutions' });
  await page.getByRole('button', { name: 'Inspect retained knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Knowledge details', exact: true }).first().click();
  await resolutions.getByLabel('Show all retained annotations, including unconnected versions').check();
  await expect(resolutions).toContainText('Requires explicit reconnection');
  await resolutions.getByLabel('I reconsidered this assertion against the selected versions above').check();
  await resolutions.getByRole('button', { name: 'Reconsider and reconnect annotation', exact: true }).click();
  await expect(resolutions).toContainText('Revision 2');
  expect(await workers()).toBe(1);
});

test('local retention expires verbose transcripts, keeps citations across restart and explicitly deletes a conversation without resurrection', async () => {
  const evidence = await page.evaluate(async () => (await window.athena.workspace()).selected!.messages.at(-1)!.evidence);
  await page.getByRole('button', { name: 'Local data', exact: true }).click();
  await expect(page.getByLabel('Verbose transcript retention (days)')).toHaveValue('30');
  await page.getByLabel('Verbose transcript retention (days)').fill('0');
  await page.getByRole('button', { name: 'Save retention policy', exact: true }).click();
  await page.getByRole('button', { name: 'Run local cleanup', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Local cleanup complete');
  const retained = await page.evaluate(async () => (await window.athena.workspace()).selected!.messages.at(-1)!);
  expect(retained.verboseExpired).toBe(true); expect(retained.evidence).toEqual(evidence); expect(retained.investigation).toBeTruthy();
  await application.close(); await launch(); expect(await workers()).toBe(0);
  await expect(page.getByRole('log')).toContainText('Verbose transcripts expired');
  await page.getByText('Inspected evidence (2)', { exact: true }).click();
  await page.getByText('[E2] answer.ts:1–1', { exact: true }).click();
  await expect(page.getByRole('log')).toContainText('export const result = C.call();');
  await page.getByRole('button', { name: 'Local data', exact: true }).click();
  await expect(page.getByLabel('Verbose transcript retention (days)')).toHaveValue('0');
  await expect(page.getByRole('button', { name: 'Delete selected conversation', exact: true })).toBeDisabled();
  await page.getByLabel('Permanently delete this conversation and its answer evidence').check();
  await page.getByRole('button', { name: 'Delete selected conversation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Conversation deleted locally');
  await expect(page.getByRole('navigation', { name: 'Saved conversations' }).getByRole('button')).toHaveCount(0);
  await application.close(); await launch();
  expect(await page.evaluate(async () => (await window.athena.workspace()).conversations)).toEqual([]); expect(await workers()).toBe(0);
});
