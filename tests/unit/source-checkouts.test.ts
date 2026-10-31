import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sources } from '../../src/main/sources';
import { SourceCheckouts } from '../../src/main/source-checkouts';
import { FOLDER_CONSENT, type InventorySnapshot } from '../../src/shared/inventory';

let root: string, sources: Sources, checkouts: SourceCheckouts;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'athena-checkout-')));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'service.ts'), 'export const value = 1;\n');
  git('add', 'service.ts');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const snapshot: InventorySnapshot = {
    roots: [{ path: root, consent: FOLDER_CONSENT, acceptedAt: 'now', includedLocations: [] }],
    repositories: [{ name: 'service', path: root, presence: 'present', documentationRoots: [], boundaries: [], fileCount: 1, examined: false }],
    candidates: [], discovery: { status: 'complete', visited: 0, current: '', nonGitFiles: 0, failures: [] },
  };
  const inventory = { snapshot: () => structuredClone(snapshot) };
  sources = new Sources(':memory:', inventory); checkouts = new SourceCheckouts(sources, inventory);
});
afterEach(() => { sources.close(); rmSync(root, { recursive: true, force: true }); });

test('local census includes tracked and untracked sources, edits, renames, deletions and branch changes without changing the checkout', async () => {
  const original = await checkouts.capture();
  expect(original).toMatchObject([{ complete: true, revision: expect.stringMatching(/^[a-f0-9]{40}$/) }]);
  expect(await checkouts.fresh(original)).toBe(true);
  writeFileSync(join(root, 'caller.ts'), 'value();\n');
  expect(await checkouts.fresh(original)).toBe(false);
  let baseline = await checkouts.capture();
  writeFileSync(join(root, 'service.ts'), 'export const value = 2;\n');
  expect(await checkouts.fresh(baseline)).toBe(false);
  baseline = await checkouts.capture();
  renameSync(join(root, 'caller.ts'), join(root, 'renamed.ts'));
  expect(await checkouts.fresh(baseline)).toBe(false);
  baseline = await checkouts.capture(); rmSync(join(root, 'renamed.ts'));
  expect(await checkouts.fresh(baseline)).toBe(false);
  baseline = await checkouts.capture(); git('checkout', '-qb', 'same-commit');
  expect(await checkouts.fresh(baseline)).toBe(false); // Same file bytes and commit, different branch.
  expect(git('branch', '--show-current').toString().trim()).toBe('same-commit');
});

test('census uses analysis eligibility and never gains environment or ignored-file access', async () => {
  writeFileSync(join(root, '.env'), 'PASSWORD=synthetic-checkout-canary');
  writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
  writeFileSync(join(root, 'ignored.ts'), 'private implementation\n');
  mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'library.js'), 'generated\n');
  const baseline = await checkouts.capture();
  expect(JSON.stringify(baseline)).not.toContain('synthetic-checkout-canary');
  writeFileSync(join(root, '.env'), 'PASSWORD=another-synthetic-canary');
  writeFileSync(join(root, 'ignored.ts'), 'different private implementation\n');
  writeFileSync(join(root, 'node_modules', 'library.js'), 'changed generated\n');
  expect(await checkouts.fresh(baseline)).toBe(true);
  expect((await sources.run('read', { root, path: '.env' })).entries[0].text).toBeUndefined();
  await sources.exception(root, 'ignored.ts', true);
  expect(await checkouts.fresh(baseline)).toBe(false);
  const included = await checkouts.capture(); writeFileSync(join(root, 'ignored.ts'), 'eligible changed implementation\n');
  expect(await checkouts.fresh(included)).toBe(false);
});
