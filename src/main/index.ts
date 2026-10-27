import { app, BrowserWindow, dialog, ipcMain, Menu, session, utilityProcess } from 'electron';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Conversations } from './conversations';
import { DesktopGateway } from './bridge';
import { JobSupervisor } from './supervisor';

app.setName('Athena');
app.enableSandbox();
// Also useful for isolated development profiles; never controlled by the renderer.
const profile = app.commandLine.getSwitchValue('user-data-dir');
if (profile) app.setPath('userData', resolve(profile));

const output = dirname(fileURLToPath(import.meta.url));
const rendererDirectory = join(output, 'renderer');
const documentURL = pathToFileURL(join(rendererDirectory, 'index.html')).href;
let window: BrowserWindow | undefined;
let conversations: Conversations | undefined;
let jobs: JobSupervisor | undefined;
let gateway: DesktopGateway | undefined;

function notify() {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('athena:changed');
  }
}

function createWindow() {
  const uiSession = session.fromPartition('athena-ui');
  uiSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  uiSession.setPermissionCheckHandler(() => false);
  // Only packaged UI assets can be requested. No web backend, uploads, or arbitrary files.
  uiSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      allowed = details.url.startsWith('file:') &&
        fileURLToPath(details.url).startsWith(rendererDirectory + sep);
    } catch { /* malformed URLs are denied */ }
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({
    width: 1120, height: 800, minWidth: 640, minHeight: 520,
    title: 'Athena', backgroundColor: '#f6f8fb',
    webPreferences: {
      preload: join(output, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webviewTag: false, webSecurity: true, session: uiSession,
    },
  });
  gateway = new DesktopGateway(conversations!, jobs!, { webContentsId: window.webContents.id, url: documentURL });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => jobs?.cancel());
  window.on('minimize', () => jobs?.lifecycle('minimize'));
  window.on('close', () => jobs?.lifecycle('window-close'));
  window.on('closed', () => { gateway = undefined; window = undefined; });
  void window.loadURL(documentURL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('before-quit', () => jobs?.lifecycle('quit'));
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => conversations?.close());
  void app.whenReady().then(() => {
    const stateDirectory = join(app.getPath('userData'), 'state');
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const database = join(stateDirectory, 'conversations.sqlite');
    conversations = new Conversations(database);
    chmodSync(database, 0o600);
    jobs = new JobSupervisor(conversations, () => utilityProcess.fork(join(output, 'worker.js'), [], {
      serviceName: 'Athena demonstration',
      // Do not inherit provider keys, shell setup, or other secrets from the launching environment.
      env: {}, stdio: 'ignore', cwd: stateDirectory,
    }), notify);
    ipcMain.handle('athena:request', (event, operation: unknown, payload: unknown) => {
      try {
        if (!gateway) throw new Error('No workspace.');
        const workspace = gateway.dispatch({
          webContentsId: event.sender.id,
          isMainFrame: event.senderFrame === event.sender.mainFrame,
          url: event.senderFrame?.url ?? '',
        }, operation, payload);
        return { ok: true, workspace };
      } catch {
        // Never serialize SQL, filesystem paths, or arbitrary native exceptions into the UI.
        return { ok: false, error: 'Request rejected. Select a conversation and try again.' };
      }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
    createWindow();
  }).catch(() => {
    dialog.showErrorBox('Athena could not start', 'Local state could not be opened. Check that your application data folder is writable, then restart Athena.');
    app.quit();
  });
}
