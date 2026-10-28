import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inventory } from '../../src/main/inventory';
import { InventoryGateway } from '../../src/main/inventory-bridge';
import { FOLDER_CONSENT } from '../../src/shared/inventory';

let directory: string;
let root: string;
let inventory: Inventory;
let gateway: InventoryGateway;
let selected: string | undefined;
const caller = { webContentsId: 7, isMainFrame: true, url: 'file:///athena/index.html' };
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'athena-inventory-bridge-')));
  root = join(directory, 'chosen');
  await mkdir(root);
  selected = root;
  inventory = new Inventory(join(directory, 'state.sqlite'));
  gateway = new InventoryGateway(inventory, caller, async () => selected);
});
afterEach(async () => { inventory.close(); await rm(directory, { recursive: true, force: true }); });

test('only a native-selected folder with the exact displayed consent can be designated', async () => {
  await expect(gateway.dispatch(caller, 'consentFolder', { path: root, consent: FOLDER_CONSENT })).rejects.toThrow();
  const choice = await gateway.dispatch(caller, 'chooseFolder', undefined);
  expect(choice.pendingFolder).toBe(root);
  expect(choice.roots).toEqual([]);
  await expect(gateway.dispatch(caller, 'consentFolder', { path: directory, consent: FOLDER_CONSENT })).rejects.toThrow();
  await expect(gateway.dispatch(caller, 'consentFolder', { path: root, consent: true })).rejects.toThrow();
  await gateway.dispatch(caller, 'consentFolder', { path: root, consent: FOLDER_CONSENT });
  expect(inventory.snapshot().roots).toMatchObject([{ path: root, consent: FOLDER_CONSENT }]);
  expect((await gateway.dispatch(caller, 'snapshot', undefined)).pendingFolder).toBeNull();
});

test('untrusted callers and malformed payloads cannot open dialogs or change inventory', async () => {
  for (const untrusted of [{ ...caller, webContentsId: 8 }, { ...caller, isMainFrame: false }, { ...caller, url: 'https://example.test' }]) {
    await expect(gateway.dispatch(untrusted, 'chooseFolder', undefined)).rejects.toThrow();
  }
  for (const [operation, payload] of [
    ['chooseFolder', { path: root }], ['snapshot', {}], ['scan', true], ['arbitrary', undefined],
    ['include', { root, location: 'docs', extra: true }], ['documentation', { name: 'repo', locations: 'docs' }],
    ['register', { path: root, alias: 'a'.repeat(101) }], ['reconnect', { name: 'repo', path: '\u0000' }],
  ]) await expect(gateway.dispatch(caller, operation, payload)).rejects.toThrow();
  expect(inventory.snapshot().roots).toEqual([]);
});

test('consent cannot be redirected by replacing the selected folder with a symlink', async () => {
  await gateway.dispatch(caller, 'chooseFolder', undefined);
  await rename(root, join(directory, 'moved'));
  await symlink(directory, root);
  await expect(gateway.dispatch(caller, 'consentFolder', { path: root, consent: FOLDER_CONSENT })).rejects.toThrow();
  expect(inventory.snapshot().roots).toEqual([]);
});

test('directory names retain significant whitespace when configuring their documentation hints', async () => {
  const path = join(root, ' atlas ');
  await mkdir(path);
  execFileSync('git', ['-C', path, 'init'], { stdio: 'pipe' });
  await inventory.designate(root, FOLDER_CONSENT);
  await inventory.scan();
  await gateway.dispatch(caller, 'documentation', { name: ' atlas ', locations: ['handbook'] });
  expect(inventory.snapshot().repositories[0]).toMatchObject({ name: ' atlas ', documentationRoots: ['handbook'] });
});

test('dismissal grants nothing, and includes cannot escape a designated root', async () => {
  await gateway.dispatch(caller, 'chooseFolder', undefined);
  await gateway.dispatch(caller, 'dismissFolder', undefined);
  await expect(gateway.dispatch(caller, 'consentFolder', { path: root, consent: FOLDER_CONSENT })).rejects.toThrow();
  selected = undefined;
  expect((await gateway.dispatch(caller, 'chooseFolder', undefined)).pendingFolder).toBeNull();
  selected = root;
  await gateway.dispatch(caller, 'chooseFolder', undefined);
  await gateway.dispatch(caller, 'consentFolder', { path: root, consent: FOLDER_CONSENT });
  await symlink(directory, join(root, 'escape'));
  for (const location of ['../', directory, 'escape']) {
    await expect(gateway.dispatch(caller, 'include', { root, location })).rejects.toThrow();
  }
});
