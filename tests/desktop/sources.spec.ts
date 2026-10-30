import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let application: ElectronApplication, page: Page, directory: string, root: string;
async function launch() {
  application = await electron.launch({ args: ['.', `--user-data-dir=${join(directory, 'profile')}`] });
  page = await application.firstWindow();
}
async function sources() { await page.getByRole('button', { name: 'Sources', exact: true }).click(); }
async function read(path: string) {
  await page.getByLabel('Relative file or directory').fill(path);
  await page.getByRole('button', { name: 'Read range', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Browsing complete');
}
test.beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-sources-desktop-'))); root = join(directory, 'chosen');
  mkdirSync(join(root, 'atlas'), { recursive: true });
  execFileSync('git', ['-C', join(root, 'atlas'), 'init'], { stdio: 'pipe' });
  writeFileSync(join(root, 'atlas', 'main.ts'), 'export const needle = 42;');
  writeFileSync(join(root, 'notes.md'), 'Loose needle documentation\n<script>not executable</script>');
  writeFileSync(join(root, '.env'), 'HIDDEN_VALUE=never-open-this');
  writeFileSync(join(root, '.env.example'), 'API_KEY=your-key\nPORT=3000');
  writeFileSync(join(root, 'suspect.md'), 'password=never-show-this');
  mkdirSync(join(root, 'vendor'));
  writeFileSync(join(root, 'vendor', 'reference.md'), 'Vendor needle reference');
  symlinkSync(directory, join(root, 'escape'));
  await launch();
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, root);
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
  await page.getByLabel('I understand the folder permission').check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect(page.getByRole('status')).toContainText('Discovery complete');
  await sources();
});
test.afterEach(async () => { await application?.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });

test('browse/search/read across approved Git and non-Git material with citations, no repeated prompts or model work', async () => {
  await page.getByLabel('Find text (literal, case-insensitive)').fill('needle');
  await page.getByRole('button', { name: 'Search sources', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Browsing complete');
  await expect(page.locator('pre')).toHaveCount(2);
  await expect(page.getByText('Non-Git document · lines 1–1')).toBeVisible();
  await expect(page.getByText('atlas · lines 1–1')).toBeVisible();
  await read('notes.md');
  await expect(page.locator('pre')).toHaveText('Loose needle documentation\n<script>not executable</script>');
  await expect(page.locator('.citation')).toContainText('sha256:');
  expect(await page.locator('script').evaluateAll(elements => elements.some(element => element.textContent?.includes('not executable')))).toBe(false);
  await page.setViewportSize({ width: 640, height: 520 });
  await expect(page.getByRole('button', { name: 'Read range', exact: true })).toBeVisible();
  expect(await application.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.name?.includes('connection') || metric.name?.includes('demonstration') || metric.name?.includes('ChatGPT')))).toBe(false);
});

test('blocks actual environments, secrets and symlink escapes through the real preload and IPC; examples remain eligible', async () => {
  await read('.env');
  await expect(page.getByText('Actual environment file is protected; current-investigation permission required.', { exact: true })).toBeVisible();
  await expect(page.locator('pre')).toHaveCount(0);
  await read('.env.example');
  await expect(page.locator('pre')).toContainText('PORT=3000');
  await read('suspect.md');
  await expect(page.getByText('Suspected secret; content withheld.', { exact: true })).toBeVisible();
  await expect(page.locator('pre')).toHaveCount(0);
  await read('escape/outside.md');
  await expect(page.locator('pre')).toHaveCount(0);
  expect(await page.evaluate(async root => {
    try { await window.athena.sources.run('read', { root, path: '../outside.md' }); return false; } catch { return true; }
  }, root)).toBe(true);
  await expect(page.getByText('never-show-this', { exact: false })).toHaveCount(0);
});

test('exposes default exclusion reasons and saves/removes narrow exceptions across restart', async () => {
  await read('vendor/reference.md');
  await expect(page.getByText('Hidden/vendor/generated directory (default exclusion).', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Include this exclusion', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.sources.exceptions()).length)).toBe(1);
  await read('vendor/reference.md');
  await expect(page.locator('pre')).toHaveText('Vendor needle reference');
  await application.close(); await launch(); await sources();
  await read('vendor/reference.md');
  await expect(page.locator('pre')).toHaveText('Vendor needle reference');
  await page.getByText('Exclusions and saved exceptions', { exact: true }).click();
  await page.getByRole('button', { name: 'Remove exception', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove exception', exact: true })).toHaveCount(0);
  await read('vendor/reference.md');
  await expect(page.locator('pre')).toHaveCount(0);
});
