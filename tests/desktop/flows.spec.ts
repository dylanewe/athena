import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLiveFixture } from './live-fixture';
import { operationCandidates, operationFiles } from '../fixtures/operation';

let application: ElectronApplication, page: Page, directory: string;
async function launch() {
  application = await electron.launch({ args: ['.', `--user-data-dir=${directory}`] });
  page = await application.firstWindow();
  await installLiveFixture(application, directory);
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
}
test.beforeEach(async () => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-flow-desktop-'))); await launch(); });
test.afterEach(async () => { await application?.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });

test('a named operation links answer, ordered flow, multiple service handoffs, system map and source evidence, retaining missing boundaries and staleness across restart', async () => {
  const root = join(directory, 'system');
  for (const name of ['shop', 'ledger']) mkdirSync(join(root, name, '.git'), { recursive: true });
  for (const [scope, path, text] of operationFiles) writeFileSync(join(root, scope, path), text);
  await installLiveFixture(application, directory, root, { investigation: {
    question: 'Trace the named checkout operation with ordered evidenced steps, synchronous service handoffs and unknown bank internals.',
    paths: operationFiles.map(([scope, path]) => `${scope}/${path}`), candidates: operationCandidates,
    text: 'Checkout calls ledger.charge() [E1], then bank.authorize() [E2]. Bank internals are unavailable [E3]. This is not a runtime trace.',
  } });
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.evaluate(() => window.athena.inventory.chooseFolder());
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I understand the folder permission' }).check();
  await page.getByRole('button', { name: 'Save consent and discover' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.inventory.snapshot()).discovery.status)).not.toBe('running');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('How does the checkout operation proceed across services?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.athena.workspace()).activeConversationId)).toBeNull();
  await page.getByRole('button', { name: 'Open investigation flows', exact: true }).click();
  await page.getByRole('button', { name: 'Checkout operation', exact: true }).click();
  const steps = page.getByRole('list', { name: 'Ordered operation steps' });
  await expect(steps.getByRole('heading', { level: 3 })).toHaveText(['Accept checkout', 'Charge account', 'Bank boundary']);
  await expect(steps.getByText('Synchronous handoff →', { exact: true })).toHaveCount(2);
  await expect(steps).toContainText('Unknown / missing implementation');
  await expect(steps).toContainText('Explicit external boundary');
  await expect(page.getByRole('region', { name: 'Flow omissions' })).toContainText('retries, failures and alternate branches not investigated');
  await page.getByRole('button', { name: 'Handoff evidence 2', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Call authorize', exact: true })).toBeVisible();
  await page.getByText('Evidence (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Read retained excerpt', exact: true }).click();
  await expect(page.locator('pre').first()).toContainText('bank.authorize()');
  await page.getByRole('button', { name: 'Inspect current file', exact: true }).click();
  await expect(page.getByText('Matches retained content.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Return to request flow', exact: true }).click();
  await page.getByRole('button', { name: 'Service: ledger / Ledger', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Dependency neighborhood' })).toContainText('Ledger');
  await page.getByRole('button', { name: 'Flows through this service', exact: true }).first().click();
  await page.getByRole('button', { name: 'Checkout operation', exact: true }).click();
  await page.getByRole('button', { name: 'Return to answer', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Checkout calls ledger.charge()');
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(1);
  for (const [scope, path, text] of operationFiles) expect(readFileSync(join(root, scope, path), 'utf8')).toBe(text);
  await application.close(); await launch();
  writeFileSync(join(root, 'ledger', 'charge.ts'), 'export function charge() { return differentBank.authorize(); }\n');
  await page.getByRole('button', { name: 'Request flows', exact: true }).click();
  await page.getByRole('button', { name: 'Checkout operation', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Ordered operation steps' })).toContainText('Sources stale');
  await page.getByRole('button', { name: 'Step evidence: Charge account', exact: true }).click();
  await page.getByText('Evidence (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Inspect current file', exact: true }).click();
  await expect(page.getByText('Changed — this is not the retained version.', { exact: false })).toBeVisible();
  expect(await application.evaluate(() => (globalThis as unknown as { liveFixture: { workers: number } }).liveFixture.workers)).toBe(0);
});
