import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FOLDER_CONSENT } from '../../src/shared/inventory';

let application: ElectronApplication;
let page: Page;
let directory: string;
let root: string;
async function launch() {
  application = await electron.launch({ args: ['.', `--user-data-dir=${join(directory, 'profile')}`] });
  page = await application.firstWindow();
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
}
async function chooseRoot() {
  // Native OS picker is the only replaced boundary; preload, IPC, filesystem and SQLite are real.
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, root);
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
}
test.beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-inventory-desktop-')));
  root = join(directory, 'chosen');
  mkdirSync(join(root, 'atlas'), { recursive: true });
  execFileSync('git', ['-C', join(root, 'atlas'), 'init'], { stdio: 'pipe' });
  writeFileSync(join(root, 'atlas', 'source.ts'), 'export const value = 1;');
  writeFileSync(join(root, 'notes.md'), 'Loose document');
  await launch();
});
test.afterEach(async () => {
  await application?.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
});

test('resolve a collision, reconnect a renamed repository, and explicitly include a skipped directory', async () => {
  for (const location of ['other/atlas', '.archive/legacy']) {
    const path = join(root, location);
    mkdirSync(path, { recursive: true });
    execFileSync('git', ['-C', path, 'init'], { stdio: 'pipe' });
  }
  await chooseRoot();
  await page.getByLabel('I understand the folder permission').check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect(page.getByRole('status')).toContainText('Discovery complete');
  await page.getByLabel(`Repository name for ${join(root, 'other', 'atlas')}`, { exact: true }).fill('billing');
  await page.getByRole('button', { name: 'Register repository', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'billing', exact: true })).toBeVisible();
  renameSync(join(root, 'other', 'atlas'), join(root, 'moved'));
  await page.getByRole('button', { name: 'Rescan folders' }).click();
  await expect(page.getByRole('status')).toContainText('Discovery complete');
  await page.getByLabel(`Reconnect a missing repository to ${join(root, 'moved')}`, { exact: true }).selectOption('billing');
  await page.getByRole('button', { name: 'Confirm reconnection' }).click();
  await expect(page.getByRole('heading', { name: 'Choose an identity' })).toHaveCount(0);
  expect(await page.evaluate(async () => (await window.athena.inventory.snapshot()).repositories.find(repo => repo.name === 'billing')?.path)).toBe(join(root, 'moved'));
  await page.getByLabel(`Include a skipped location within ${root}`, { exact: true }).fill('.archive/legacy');
  await page.getByRole('button', { name: 'Include and rescan' }).click();
  await expect(page.getByRole('heading', { name: 'legacy', exact: true })).toBeVisible();
});

test('folder consent, local discovery, documentation hints, and launch-time rediscovery survive restart without model work', async () => {
  await chooseRoot();
  await expect(page.getByText(FOLDER_CONSENT, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save consent and discover' })).toBeDisabled();
  expect(await page.evaluate(async () => (await window.athena.inventory.snapshot()).roots)).toEqual([]);
  await page.getByLabel('I understand the folder permission').check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect(page.getByRole('status')).toContainText('Discovery complete');
  await expect(page.getByRole('heading', { name: 'atlas', exact: true })).toBeVisible();
  await expect(page.getByText('Unexamined', { exact: true })).toBeVisible();
  await expect(page.getByText('1 non-Git files', { exact: false })).toBeVisible();
  await page.getByLabel('Documentation starting directories for atlas').fill('handbook\nreference');
  await page.getByRole('button', { name: 'Save documentation hints for atlas' }).click();
  await application.close();
  mkdirSync(join(root, 'new-repository'));
  execFileSync('git', ['-C', join(root, 'new-repository'), 'init'], { stdio: 'pipe' });
  await launch();
  await expect(page.getByRole('status')).toContainText('Discovery complete');
  await expect(page.getByRole('heading', { name: 'new-repository', exact: true })).toBeVisible();
  await expect(page.getByLabel('Documentation starting directories for atlas')).toHaveValue('handbook\nreference');
  expect(await page.evaluate(async () => (await window.athena.inventory.snapshot()).roots[0].consent)).toBe(FOLDER_CONSENT);
  expect(await application.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.name === 'Athena demonstration'))).toBe(false);
});
