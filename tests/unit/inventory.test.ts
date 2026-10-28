import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, rename } from 'node:fs/promises';
import { renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { Inventory } from '../../src/main/inventory';
import { FOLDER_CONSENT } from '../../src/shared/inventory';

let directory: string;
let root: string;
let inventory: Inventory;
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
async function repository(path: string) {
  await mkdir(path, { recursive: true });
  git(path, 'init');
  await writeFile(join(path, 'source.ts'), 'export const answer = 42;');
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'athena-inventory-')));
  root = join(directory, 'chosen');
  await mkdir(root);
  inventory = new Inventory(join(directory, 'inventory.sqlite'));
});
afterEach(async () => { inventory.close(); await rm(directory, { recursive: true, force: true }); });

test('cancellation retains partial progress without inventing missing repositories and can resume', async () => {
  await repository(join(root, 'alpha'));
  await repository(join(root, 'beta'));
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  inventory.close();
  let cancel = true;
  inventory = new Inventory(join(directory, 'inventory.sqlite'), () => {
    if (cancel && inventory.snapshot().discovery.visited === 1) { cancel = false; inventory.cancel(); }
  });
  await inventory.scan();
  expect(inventory.snapshot().discovery.status).toBe('cancelled');
  expect(inventory.snapshot().repositories.map(repo => repo.presence)).toEqual(['unknown', 'unknown']);
  await inventory.scan();
  expect(inventory.snapshot().repositories.map(repo => repo.presence)).toEqual(['present', 'present']);
});

test('failures are visible; replacing a designated root with a symlink never discovers outside material', async () => {
  await repository(join(root, 'inside'));
  await repository(join(directory, 'outside'));
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  await rename(root, join(directory, 'moved-root'));
  await symlink(join(directory, 'outside'), root);
  await inventory.scan();
  expect(inventory.snapshot().discovery.failures).toEqual([{ path: root, message: expect.any(String) }]);
  expect(inventory.snapshot().repositories.map(repo => [repo.name, repo.presence])).toEqual([['inside', 'unknown']]);
});

test('discovery rechecks a directory if it becomes a symlink while reporting progress', async () => {
  await repository(join(directory, 'outside'));
  inventory.close();
  let swapped = false;
  inventory = new Inventory(join(directory, 'inventory.sqlite'), () => {
    if (!swapped && inventory.snapshot().discovery.current === root) {
      swapped = true;
      renameSync(root, join(directory, 'old-root'));
      symlinkSync(join(directory, 'outside'), root);
    }
  });
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  expect(inventory.snapshot().repositories).toEqual([]);
  expect(inventory.snapshot().discovery.failures).toHaveLength(1);
});

test('documentation starting directories are persisted hints, not content boundaries', async () => {
  const repo = join(root, 'atlas');
  await repository(repo);
  await mkdir(join(repo, 'handbook'));
  await writeFile(join(repo, 'handbook', 'intro.md'), 'Intro');
  await symlink(directory, join(repo, 'outside'));
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  await inventory.documentation('atlas', ['handbook', 'future-docs']);
  expect(inventory.snapshot().repositories[0]).toMatchObject({ documentationRoots: ['handbook', 'future-docs'], fileCount: 2 });
  for (const location of ['../', '/tmp', 'outside', '.git']) await expect(inventory.documentation('atlas', [location])).rejects.toThrow();
  inventory.close();
  inventory = new Inventory(join(directory, 'inventory.sqlite'));
  await inventory.scan();
  expect(inventory.snapshot().repositories[0].documentationRoots).toEqual(['handbook', 'future-docs']);
});

test('collisions require unique aliases; moves require explicit reconnection and keep the original identity', async () => {
  await repository(join(root, 'one', 'api'));
  await repository(join(root, 'two', 'api'));
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  expect(inventory.snapshot().repositories.map(repo => repo.name)).toEqual(['api']);
  expect(inventory.snapshot().candidates).toMatchObject([{ path: join(root, 'two', 'api'), reason: 'collision' }]);
  expect(() => inventory.register(join(root, 'two', 'api'), 'API')).toThrow();
  inventory.register(join(root, 'two', 'api'), 'billing');
  await rename(join(root, 'two', 'api'), join(root, 'renamed'));
  await inventory.scan();
  expect(inventory.snapshot().repositories.find(repo => repo.name === 'billing')?.presence).toBe('missing');
  expect(inventory.snapshot().candidates).toMatchObject([{ path: join(root, 'renamed'), reason: 'connection' }]);
  inventory.reconnect('billing', join(root, 'renamed'));
  expect(inventory.snapshot().repositories.map(repo => [repo.name, repo.presence])).toEqual([['api', 'present'], ['billing', 'present']]);
  inventory.close();
  inventory = new Inventory(join(directory, 'inventory.sqlite'));
  await inventory.scan();
  expect(inventory.snapshot().repositories.find(repo => repo.name === 'billing')?.path).toBe(join(root, 'renamed'));
  expect(inventory.snapshot().candidates).toEqual([]);
});

test('default exclusions and explicit includes stay inside roots and never follow symlinks', async () => {
  await repository(join(root, 'visible'));
  for (const path of ['.hidden/secret', 'node_modules/dep', 'vendor/library', 'dist/output']) await repository(join(root, path));
  await repository(join(directory, 'outside'));
  await symlink(join(directory, 'outside'), join(root, 'escape'));
  await symlink(join(root, 'visible'), join(root, 'duplicate'));
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  expect(inventory.snapshot().repositories.map(repo => repo.name)).toEqual(['visible']);
  await inventory.include(root, 'node_modules/dep');
  await inventory.include(root, '.hidden/secret');
  await inventory.scan();
  expect(inventory.snapshot().repositories.map(repo => repo.name).sort()).toEqual(['dep', 'secret', 'visible']);
  for (const location of ['../outside', join(directory, 'outside'), 'escape', 'duplicate', 'visible/.git']) {
    await expect(inventory.include(root, location)).rejects.toThrow();
  }
  inventory.close();
  inventory = new Inventory(join(directory, 'inventory.sqlite'));
  expect(inventory.snapshot().roots[0].includedLocations).toEqual(['node_modules/dep', '.hidden/secret']);
});

test('nested repositories, submodules, and worktrees own their contents separately', async () => {
  const parent = join(root, 'parent');
  await repository(parent);
  git(parent, 'add', '.');
  git(parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  await repository(join(parent, 'nested'));
  const external = join(directory, 'external');
  await repository(external);
  git(external, 'add', '.');
  git(external, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', external, 'module');
  git(external, 'worktree', 'add', join(root, 'worktree'));
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  expect(inventory.snapshot().repositories.map(repo => [repo.name, repo.fileCount])).toEqual([
    ['parent', 2], ['module', 1], ['nested', 1], ['worktree', 1],
  ]);
  expect(inventory.snapshot().repositories[0].boundaries).toEqual([join(parent, 'module'), join(parent, 'nested')]);
});

test('cancelling after discovering a renamed repository still allows explicit reconnection after rescan', async () => {
  await repository(join(root, 'original'));
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  await inventory.documentation('original', ['handbook']);
  await rename(join(root, 'original'), join(root, 'renamed'));
  await mkdir(join(root, 'renamed', 'child'));
  inventory.close();
  let shouldCancel = true;
  inventory = new Inventory(join(directory, 'inventory.sqlite'), () => {
    if (shouldCancel && inventory.snapshot().discovery.current === join(root, 'renamed', 'child')) {
      shouldCancel = false;
      inventory.cancel();
    }
  });
  await inventory.scan();
  expect(inventory.snapshot().discovery.status).toBe('cancelled');
  await inventory.scan();
  inventory.reconnect('original', join(root, 'renamed'));
  expect(inventory.snapshot().repositories).toMatchObject([{ name: 'original', path: join(root, 'renamed'), documentationRoots: ['handbook'], presence: 'present' }]);
  expect(inventory.snapshot().repositories).toHaveLength(1);
});

test('an unresolved collision cannot be registered from unchecked results after cancellation', async () => {
  await repository(join(root, 'one', 'api'));
  await repository(join(root, 'two', 'api'));
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  inventory.close();
  inventory = new Inventory(join(directory, 'inventory.sqlite'), () => {
    if (inventory.snapshot().discovery.status === 'running') inventory.cancel();
  });
  await inventory.scan();
  expect(() => inventory.register(join(root, 'two', 'api'), 'billing')).toThrow();
  expect(inventory.snapshot().candidates).toMatchObject([{ presence: 'unknown' }]);
});

test('including a skipped descendant does not register excluded ancestor repositories or attribute their files to a parent', async () => {
  await repository(root);
  await repository(join(root, 'vendor'));
  await repository(join(root, 'vendor', 'wanted'));
  await mkdir(join(root, 'vendor', 'handbook'));
  await writeFile(join(root, 'vendor', 'handbook', 'intro.md'), 'Owned by excluded vendor');
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.include(root, 'vendor/wanted');
  await inventory.include(root, 'vendor/handbook');
  await inventory.scan();
  expect(inventory.snapshot().repositories.map(repo => [repo.name, repo.fileCount])).toEqual([['chosen', 1], ['wanted', 1]]);
  expect(inventory.snapshot().candidates).toEqual([]);
  expect(inventory.snapshot().discovery.nonGitFiles).toBe(0);
});

test('overlapping roots and explicitly included descendants do not duplicate or misattribute content', async () => {
  const parent = join(root, 'parent');
  await repository(parent);
  await repository(join(parent, '.hidden', 'child'));
  await writeFile(join(parent, '.hidden', 'skipped.md'), 'Not explicitly included');
  await inventory.designate(join(parent, '.hidden', 'child'), FOLDER_CONSENT);
  await inventory.designate(root, FOLDER_CONSENT);
  const before = git(parent, 'status', '--porcelain').toString();
  await inventory.scan();
  expect(inventory.snapshot().repositories.map(repo => [repo.name, repo.fileCount])).toEqual([['parent', 1], ['child', 1]]);
  expect(inventory.snapshot().repositories[0].boundaries).toEqual([join(parent, '.hidden', 'child')]);
  expect(inventory.snapshot().discovery.nonGitFiles).toBe(0);
  expect(git(parent, 'status', '--porcelain').toString()).toBe(before);
});

test('a persistence failure is visible and a rescan can recover without losing saved consent', async () => {
  await repository(join(root, 'atlas'));
  await inventory.designate(root, FOLDER_CONSENT);
  const writer = new DatabaseSync(join(directory, 'inventory.sqlite'));
  try {
    writer.exec('BEGIN IMMEDIATE');
    await inventory.scan();
    expect(inventory.snapshot().discovery).toMatchObject({ status: 'failed', failures: [{ message: 'Could not save inventory. Check local storage and rescan.' }] });
    expect(inventory.snapshot().roots).toMatchObject([{ path: root, consent: FOLDER_CONSENT }]);
    writer.exec('ROLLBACK');
    await inventory.scan();
    expect(inventory.snapshot().discovery).toMatchObject({ status: 'complete', failures: [] });
    expect(inventory.snapshot().repositories[0].name).toBe('atlas');
  } finally { writer.close(); }
});

test('folder consent and ordinary repositories survive restart; loose documents remain eligible', async () => {
  await repository(join(root, 'atlas'));
  await writeFile(join(root, 'notes.md'), 'Non-Git material');
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  expect(inventory.snapshot()).toMatchObject({
    roots: [{ path: root, consent: FOLDER_CONSENT, includedLocations: [] }],
    repositories: [{ name: 'atlas', path: join(root, 'atlas'), presence: 'present', documentationRoots: ['docs'], fileCount: 1, boundaries: [], examined: false }],
    discovery: { status: 'complete', nonGitFiles: 1, failures: [] },
  });
  inventory.close();
  inventory = new Inventory(join(directory, 'inventory.sqlite'));
  expect(inventory.snapshot().roots[0].acceptedAt).toEqual(expect.any(String));
  expect(inventory.snapshot().repositories[0].name).toBe('atlas');
  await expect(inventory.designate(root, 'different permission')).rejects.toThrow();
});
