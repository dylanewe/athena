import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLargeMap } from '../fixtures/large-map';

let directory: string, fixture: Awaited<ReturnType<typeof createLargeMap>>, application: ElectronApplication, page: Page;
test.beforeAll(async () => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-large-ui-'))); fixture = await createLargeMap(directory); });
for (let start = 0; start < 100; start += 10) test.beforeAll(async () => { await fixture.populate(start, start + 10); });
test.beforeAll(async () => { fixture.close(); application = await electron.launch({ args: ['.', `--user-data-dir=${directory}`] }); page = await application.firstWindow(); });
test.afterAll(async () => { await application?.close(); rmSync(directory, { recursive: true, force: true }); });

test('a large inventory remains bounded at 200, supports keyboard paging, and replaces the view on scope changes', async () => {
  const start = performance.now();
  await page.getByRole('button', { name: 'Services & dependencies', exact: true }).click();
  const coverage = page.getByRole('status', { name: 'Map coverage' });
  await expect(coverage).toContainText('visible');
  const openMs = performance.now() - start;
  await page.getByLabel('Traversal depth').selectOption('0');
  await page.getByRole('button', { name: 'Show neighborhood', exact: true }).click();
  const map = page.getByRole('region', { name: 'Dependency neighborhood' });
  await expect(map.locator('.entity')).toHaveCount(20);
  const timings: number[] = [];
  for (let count = 40; count <= 200; count += 20) {
    const button = page.getByRole('button', { name: 'Load more map results', exact: true });
    const start = performance.now();
    await button.focus(); await page.keyboard.press('Enter');
    await expect(map.locator('.entity')).toHaveCount(count);
    timings.push(performance.now() - start);
  }
  await expect(page.getByRole('button', { name: 'Load more map results', exact: true })).toBeDisabled();
  await expect(coverage).toContainText('Content omitted or not loaded');
  await expect(page.getByText('Focused-view limit reached.', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'test-results/map-200.png' });
  const scopeStart = performance.now();
  await page.getByLabel('Map repository scope').selectOption('repo-000');
  await page.getByRole('button', { name: 'Show neighborhood', exact: true }).click();
  await expect(map.locator('.entity')).toHaveCount(10);
  await expect(map).not.toContainText('Service 99-');
  const scopeMs = performance.now() - scopeStart;
  await page.getByLabel('Map repository scope').selectOption('');
  await page.getByLabel('Map name or topic').fill('Service 99');
  await page.getByRole('button', { name: 'Show neighborhood', exact: true }).click();
  await expect(map.locator('.entity')).toHaveCount(10);
  await expect(map).toContainText('Service 99-0');
  const neighbor = map.getByRole('button', { name: 'Focus entity', exact: true }).first();
  await neighbor.focus(); await page.keyboard.press('Enter');
  await expect(map.locator('.entity')).toHaveCount(1);
  await map.getByRole('button', { name: 'Expand neighbors', exact: true }).click();
  await expect(map.locator('.entity')).toHaveCount(3);
  await expect(map.getByRole('button', { name: 'Expand neighbors', exact: true }).first()).toBeDisabled();
  await map.getByRole('button', { name: 'Collapse neighbors', exact: true }).click();
  await expect(map.locator('.entity')).toHaveCount(1);
  console.log('MAP_DESKTOP_BENCHMARK', JSON.stringify({ runtime: await application.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome })), openMs, pages: timings.length, medianPageMs: [...timings].sort((a, b) => a - b)[4], maxPageMs: Math.max(...timings), scopeMs }));
});
