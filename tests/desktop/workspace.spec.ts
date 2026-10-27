import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let application: ElectronApplication;
let page: Page;
let directory: string;
let pausedWorker: number | undefined;

// Pause the real OS process before it executes a job. No test controls ship in Athena.
async function pauseNextWorker() {
  await application.evaluate(({ utilityProcess }) => {
    const fork = utilityProcess.fork;
    utilityProcess.fork = (...args) => {
      utilityProcess.fork = fork;
      const child = fork(...args);
      child.once('spawn', () => process.kill(child.pid!, 'SIGSTOP'));
      return child;
    };
  });
}
async function workerPid() {
  let pid: number | undefined;
  await expect.poll(async () => {
    pid = await application.evaluate(({ app }) => app.getAppMetrics().find(metric => metric.name === 'Athena demonstration')?.pid);
    return pid;
  }).toBeTruthy();
  return pid!;
}
async function launch() {
  application = await electron.launch({ args: ['.', `--user-data-dir=${directory}`] });
  page = await application.firstWindow();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
}
async function create(title: string) {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Conversation name').fill(title);
  await page.getByRole('button', { name: 'Create conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
async function send(text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

test.beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'athena-desktop-'));
  await launch();
});
test.afterEach(async () => {
  if (pausedWorker) {
    try { process.kill(pausedWorker, 'SIGCONT'); } catch { /* already terminated */ }
    pausedWorker = undefined;
  }
  await application?.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
});

test('create, select, and reopen a conversation with its deterministic answer after restart', async () => {
  await create('First investigation');
  await send('What can Athena do today?');
  await expect(page.getByText('Local demonstration complete.', { exact: false })).toBeVisible();
  await create('Second investigation');
  await page.getByRole('button', { name: 'First investigation', exact: true }).click();
  await application.close();
  await launch();
  await expect(page.getByRole('heading', { name: 'First investigation' })).toBeVisible();
  await expect(page.getByText('What can Athena do today?', { exact: true })).toBeVisible();
  await expect(page.getByText('Local demonstration complete.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Second investigation', exact: true }).click();
  await expect(page.getByText('What can Athena do today?', { exact: true })).toHaveCount(0);
});

test('a real utility-process crash is visible and the workspace remains usable', async () => {
  await create('Crash recovery');
  await pauseNextWorker();
  await send('This job will be interrupted');
  pausedWorker = await workerPid();
  process.kill(pausedWorker, 'SIGKILL');
  pausedWorker = undefined;
  await expect(page.getByText('Demonstration process stopped.', { exact: false })).toBeVisible();
  await send('Try again');
  await expect(page.getByText('Local demonstration complete.', { exact: false })).toBeVisible();
});

test('minimizing keeps the real job active and it can finish after restore', async () => {
  await create('Minimized work');
  await pauseNextWorker();
  await send('Keep working');
  pausedWorker = await workerPid();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  expect(await page.evaluate(async () => (await window.athena.workspace()).selected?.messages.at(-1)?.status)).toBe('running');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  process.kill(pausedWorker, 'SIGCONT');
  pausedWorker = undefined;
  await expect(page.getByText('Local demonstration complete.', { exact: false })).toBeVisible();
});

for (const action of ['close window', 'quit'] as const) {
  test(`${action} cancels active work and allows a clean restart`, async () => {
    await create('Lifecycle recovery');
    await pauseNextWorker();
    await send('Retain my question');
    pausedWorker = await workerPid();
    // Resume immediately after requesting shutdown so SIGTERM can be delivered even
    // to this artificially stopped process. The parent cancels before destroying UI.
    const closed = application.waitForEvent('close');
    await application.evaluate(({ app, BrowserWindow }, action) => {
      if (action === 'quit') app.quit();
      else BrowserWindow.getAllWindows()[0].close();
    }, action);
    try { process.kill(pausedWorker, 'SIGCONT'); } catch { /* already terminated */ }
    pausedWorker = undefined;
    await closed;
    await launch();
    await expect(page.getByText('Demonstration cancelled.', { exact: false })).toBeVisible();
    await expect(page.getByText('Retain my question', { exact: true })).toBeVisible();
    await send('Continue after restarting');
    await expect(page.getByText('Local demonstration complete.', { exact: false })).toBeVisible();
  });
}

test('abrupt application interruption recovers the pending transcript on restart', async () => {
  await create('Unexpected interruption');
  await pauseNextWorker();
  await send('Keep the question after a crash');
  pausedWorker = await workerPid();
  const closed = application.waitForEvent('close');
  application.process().kill('SIGKILL');
  await closed;
  try { process.kill(pausedWorker, 'SIGKILL'); } catch { /* parent death already reaped it */ }
  pausedWorker = undefined;
  await launch();
  await expect(page.getByText('Demonstration interrupted.', { exact: false })).toBeVisible();
  await send('A fresh job');
  await expect(page.getByText('Local demonstration complete.', { exact: false })).toBeVisible();
});

test('a storage failure still stops the worker and offers a visible save retry', async () => {
  await create('Save recovery');
  await pauseNextWorker();
  await send('Keep this question when storage is busy');
  pausedWorker = await workerPid();
  const otherWriter = new DatabaseSync(join(directory, 'state', 'conversations.sqlite'));
  try {
    otherWriter.exec('BEGIN IMMEDIATE');
    await page.getByRole('button', { name: 'Stop demonstration' }).click();
    await expect(page.getByRole('alert')).toContainText('result could not be saved');
    const pid = pausedWorker;
    try { process.kill(pid, 'SIGCONT'); } catch { /* already terminated */ }
    pausedWorker = undefined;
    await expect.poll(() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }).toBe(false);
    otherWriter.exec('ROLLBACK');
    await page.getByRole('button', { name: 'Retry saving' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('Demonstration cancelled.', { exact: false })).toBeVisible();
    await send('Continue after saving');
    await expect(page.getByText('Local demonstration complete.', { exact: false })).toBeVisible();
  } finally { otherWriter.close(); }
});

test('the renderer is sandboxed, has a narrow bridge, and cannot fetch files or network resources', async () => {
  expect(await page.evaluate(() => ({
    node: typeof (globalThis as Record<string, unknown>).process,
    require: typeof (globalThis as Record<string, unknown>).require,
    bridge: Object.keys(window.athena).sort(),
  }))).toEqual({ node: 'undefined', require: 'undefined', bridge: ['cancel', 'create', 'onChange', 'select', 'send', 'workspace'] });
  expect(await application.evaluate(({ app, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
    return app.getAppMetrics().find(metric => metric.pid === pid)?.sandboxed;
  })).toBe(true);
  for (const url of ['https://example.com', 'file:///etc/hosts']) {
    expect(await page.evaluate(async url => {
      try { await fetch(url); return 'accessible'; } catch { return 'denied'; }
    }, url)).toBe('denied');
  }
  expect(await page.evaluate(async () => {
    try { await window.athena.create({ title: 'malformed' } as unknown as string); return 'accepted'; }
    catch { return 'rejected'; }
  })).toBe('rejected');
});

test('a second real renderer cannot use the owner window’s bridge', async () => {
  const secondWindow = application.waitForEvent('window');
  await application.evaluate(async ({ app, BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const outsider = new BrowserWindow({ show: false, webPreferences: {
      preload: `${app.getAppPath()}/dist/preload.cjs`,
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    await outsider.loadURL(owner.webContents.getURL());
  });
  const outsider = await secondWindow;
  expect(await outsider.evaluate(async () => {
    try { await window.athena.workspace(); return 'accepted'; } catch { return 'rejected'; }
  })).toBe('rejected');
});
