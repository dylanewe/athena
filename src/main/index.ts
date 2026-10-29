import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, session, utilityProcess } from 'electron';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Conversations } from './conversations';
import { DesktopGateway } from './bridge';
import { JobSupervisor } from './supervisor';
import { Inventory } from './inventory';
import { InventoryGateway } from './inventory-bridge';
import { ModelSettings, ModelSettingsError } from './model-settings';
import { ModelGateway } from './model-bridge';
import { ConnectionProcess } from './connection-process';

app.setName('Athena');
app.enableSandbox();
nativeTheme.themeSource = 'dark';
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
let inventory: Inventory | undefined;
let inventoryGateway: InventoryGateway | undefined;
let modelSettings: ModelSettings | undefined;
let modelGateway: ModelGateway | undefined;

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
    title: 'Athena', backgroundColor: '#242526',
    webPreferences: {
      preload: join(output, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webviewTag: false, webSecurity: true, session: uiSession,
    },
  });
  gateway = new DesktopGateway(conversations!, jobs!, { webContentsId: window.webContents.id, url: documentURL });
  inventoryGateway = new InventoryGateway(inventory!, { webContentsId: window.webContents.id, url: documentURL }, async () => {
    if (!window || window.isDestroyed()) return;
    const result = await dialog.showOpenDialog(window, { title: 'Choose a folder for Athena', properties: ['openDirectory'], buttonLabel: 'Review permission' });
    return result.canceled ? undefined : result.filePaths[0];
  });
  modelGateway = new ModelGateway(modelSettings!, { webContentsId: window.webContents.id, url: documentURL });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { jobs?.cancel(); inventory?.cancel(); modelSettings?.cancel(); });
  window.on('minimize', () => jobs?.lifecycle('minimize'));
  window.on('close', () => { jobs?.lifecycle('window-close'); inventory?.cancel(); modelSettings?.cancel(); });
  window.on('closed', () => { gateway = undefined; inventoryGateway = undefined; modelGateway = undefined; window = undefined; });
  void window.loadURL(documentURL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('before-quit', () => { jobs?.lifecycle('quit'); inventory?.cancel(); modelSettings?.cancel(); });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { conversations?.close(); inventory?.close(); modelSettings?.close(); });
  void app.whenReady().then(() => {
    const stateDirectory = join(app.getPath('userData'), 'state');
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const database = join(stateDirectory, 'conversations.sqlite');
    conversations = new Conversations(database);
    chmodSync(database, 0o600);
    const inventoryDatabase = join(stateDirectory, 'inventory.sqlite');
    inventory = new Inventory(inventoryDatabase, notify);
    chmodSync(inventoryDatabase, 0o600);
    jobs = new JobSupervisor(conversations, () => utilityProcess.fork(join(output, 'worker.js'), [], {
      serviceName: 'Athena demonstration',
      // Do not inherit provider keys, shell setup, or other secrets from the launching environment.
      env: {}, stdio: 'ignore', cwd: stateDirectory,
    }), notify);
    const modelDatabase = join(stateDirectory, 'models.sqlite');
    modelSettings = new ModelSettings(modelDatabase, {
      // On macOS safeStorage encrypts using a key held in the login Keychain.
      // Never fall back to Linux basic_text or ordinary plaintext storage.
      available: () => process.platform === 'darwin' && safeStorage.isEncryptionAvailable(),
      encrypt: key => safeStorage.encryptString(key),
      decrypt: bytes => safeStorage.decryptString(Buffer.from(bytes)),
    }, new ConnectionProcess(() => utilityProcess.fork(join(output, 'connection.js'), [], {
      serviceName: 'Athena connection test', env: {}, stdio: 'ignore', cwd: stateDirectory,
    })), notify);
    chmodSync(modelDatabase, 0o600);
    ipcMain.handle('athena:models', (event, operation: unknown, payload: unknown) => {
      try {
        if (!modelGateway) throw new Error('No model settings.');
        const models = modelGateway.dispatch({
          webContentsId: event.sender.id,
          isMainFrame: event.senderFrame === event.sender.mainFrame,
          url: event.senderFrame?.url ?? '',
        }, operation, payload);
        return { ok: true, models };
      } catch (error) {
        return { ok: false, error: error instanceof ModelSettingsError ? error.message :
          'Model settings request rejected. Check the entered values and available local storage, then retry.' };
      }
    });
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
    ipcMain.handle('athena:inventory', async (event, operation: unknown, payload: unknown) => {
      try {
        if (!inventoryGateway) throw new Error('No workspace.');
        const result = await inventoryGateway.dispatch({
          webContentsId: event.sender.id,
          isMainFrame: event.senderFrame === event.sender.mainFrame,
          url: event.senderFrame?.url ?? '',
        }, operation, payload);
        return { ok: true, inventory: result };
      } catch {
        return { ok: false, error: 'Inventory change rejected. Finish discovery first; check the selected folder, unique name, and relative directories, then retry.' };
      }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
    createWindow();
    void inventory.scan();
  }).catch(() => {
    dialog.showErrorBox('Athena could not start', 'Local state could not be opened. Check that your application data folder is writable, then restart Athena.');
    app.quit();
  });
}
