import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLiveFixture } from './live-fixture';
import type { KnowledgeCandidate } from '../../src/shared/knowledge';
import { branchingCandidates, branchingFiles, operationCandidates, operationFiles, parallelCandidates, parallelFiles } from '../fixtures/operation';

let application: ElectronApplication, page: Page, directory: string;
async function launch() {
  application = await electron.launch({ args: ['.', `--user-data-dir=${directory}`] });
  page = await application.firstWindow();
  await installLiveFixture(application, directory);
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
}
test.beforeEach(async () => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'athena-flow-desktop-'))); await launch(); });
test.afterEach(async () => { await application?.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });

async function investigate(candidates: KnowledgeCandidate[], files: readonly (readonly [string, string, string])[], question: string, text: string) {
  const root = join(directory, 'system');
  for (const name of ['shop', 'ledger']) mkdirSync(join(root, name, '.git'), { recursive: true });
  for (const [scope, path, content] of files) writeFileSync(join(root, scope, path), content);
  await installLiveFixture(application, directory, root, { investigation: {
    question, paths: files.map(([scope, path]) => `${scope}/${path}`), candidates, text,
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
  return root;
}

test('conditional outcomes, async gaps and annotated retries/loops remain inspectable while users focus and collapse portions', async () => {
  const root = await investigate(branchingCandidates, branchingFiles,
    'Explore checkout success/failure, payment events, bounded retry and item iteration without expanding paths.',
    'Checkout validates input [E1], retries charging and publishes items [E2]. Consumer implementation remains unknown [E3].');
  await page.getByRole('button', { name: 'Open investigation flows', exact: true }).click();
  await page.getByRole('button', { name: 'Checkout operation', exact: true }).click();
  let portions = page.getByRole('list', { name: 'Operation flow portions' });
  await expect(portions.getByRole('heading', { level: 3 })).toHaveText(['Checkout valid?', 'Charge with retry', 'Consumer unavailable', 'Reject invalid checkout', 'Publish payment items']);
  await expect(portions).toContainText('If: Valid checkout / success');
  await expect(portions).toContainText('If: Invalid checkout / failure');
  await expect(portions).toContainText('Retry (annotated)');
  await expect(portions).toContainText('At most 3 attempts');
  await expect(portions).toContainText('Loop (annotated)');
  await expect(portions).toContainText('One publication per item');
  await expect(portions).toContainText('Asynchronous event/message →');
  await expect(portions).toContainText('To S3 · Consumer unavailable');
  await expect(portions).toContainText('Consumer subscription and delivery guarantees were not inspected.');
  await expect(portions).toContainText('Unknown / missing implementation');
  await page.getByRole('button', { name: 'Focus: Checkout valid?', exact: true }).click();
  await expect(portions.getByRole('heading', { level: 3 })).toHaveText(['Checkout valid?']);
  await expect(page.getByRole('status', { name: 'Hidden flow content' })).toContainText('4 hidden steps · 0 collapsed portions · 2 hidden handoffs');
  await expect(portions).toContainText('To S4 · Reject invalid checkout (hidden by focus)');
  await page.getByRole('button', { name: 'Show all portions', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse: Checkout valid?', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Hidden flow content' })).toContainText('0 hidden steps · 1 collapsed portions · 2 hidden handoffs');
  await expect(portions.getByText('If: Invalid checkout / failure', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand: Checkout valid?', exact: true }).click();
  await expect(portions).toContainText('If: Invalid checkout / failure');
  await page.getByRole('button', { name: 'Handoff evidence 4', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Call authorize', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Return to request flow', exact: true }).click();
  for (const [scope, path, text] of branchingFiles) expect(readFileSync(join(root, scope, path), 'utf8')).toBe(text);
  await application.close(); await launch();
  await page.getByRole('button', { name: 'Request flows', exact: true }).click();
  await page.getByRole('button', { name: 'Checkout operation', exact: true }).click();
  portions = page.getByRole('list', { name: 'Operation flow portions' });
  await expect(portions).toContainText('Loop (annotated)');
  writeFileSync(join(root, 'ledger', 'charge.ts'), 'changed();');
  await page.getByRole('button', { name: 'Check flow freshness', exact: true }).click();
  await expect(portions).toContainText('Sources stale');
});

test('parallel dispatch and a partial-evidence join are explicit rather than inferred from visual order', async () => {
  const candidates = structuredClone(parallelCandidates);
  candidates[8].flow!.steps[1].state = 'unknown';
  candidates[8].flow!.steps[3].state = 'unknown';
  candidates[8].flow!.steps[3].omissions = ['Worker completion needs further evidence.'];
  await investigate(candidates, parallelFiles, 'Explore checkout parallel dispatch with partial completion evidence.', 'Parallel dispatch is evidenced [E1]; completion remains unresolved [E2].');
  await page.getByRole('button', { name: 'Open investigation flows', exact: true }).click();
  await page.getByRole('button', { name: 'Checkout operation', exact: true }).click();
  const portions = page.getByRole('list', { name: 'Operation flow portions' });
  await expect(portions).toContainText('Parallel dispatch');
  await expect(portions).toContainText('Unresolved: Convergence / join');
  await expect(portions).toContainText('Worker completion needs further evidence.');
  await expect(portions).toContainText('Gap only: ordering, causality and synchronization are not established');
  await page.getByRole('button', { name: 'Step evidence: Await charge and validation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Await charge and validation', exact: true })).toBeVisible();
});

test('a named operation links answer, ordered flow, multiple service handoffs, system map and source evidence, retaining missing boundaries and staleness across restart', async () => {
  const root = await investigate(operationCandidates, operationFiles,
    'Trace the named checkout operation with ordered evidenced steps, synchronous service handoffs and unknown bank internals.',
    'Checkout calls ledger.charge() [E1], then bank.authorize() [E2]. Bank internals are unavailable [E3]. This is not a runtime trace.');
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
