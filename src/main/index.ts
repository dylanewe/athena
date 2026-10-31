import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, session, shell, utilityProcess } from 'electron';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Conversations } from './conversations';
import { Knowledge } from './knowledge';
import { KnowledgeGateway } from './knowledge-bridge';
import { DesktopGateway } from './bridge';
import { LiveSupervisor, LiveError } from './live-supervisor';
import { Inventory } from './inventory';
import { InventoryGateway } from './inventory-bridge';
import { ModelSettings, ModelSettingsError } from './model-settings';
import { ModelGateway } from './model-bridge';
import { ApiSettings } from './api-settings';
import { ApiModelGateway } from './api-model-bridge';
import { ApiSettingsError } from './pi-model-config';
import { runCredentialHelper } from './api-credentials';
import { ConnectionProcess } from './connection-process';
import { Sources } from './sources';
import { SourceGateway } from './source-bridge';
import { ChatGPTStore } from './chatgpt-store';
import { ChatGPTOAuth, ChatGPTError } from './chatgpt-protocol';
import { ChatGPTSettings } from './chatgpt-settings';
import { ChatGPTProcess } from './chatgpt-process';
import { ChatGPTGateway } from './chatgpt-bridge';

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
let knowledge: Knowledge | undefined;
let knowledgeGateway: KnowledgeGateway | undefined;
let jobs: LiveSupervisor | undefined;
let gateway: DesktopGateway | undefined;
let inventory: Inventory | undefined;
let inventoryGateway: InventoryGateway | undefined;
let modelSettings: ModelSettings | undefined;
let modelGateway: ModelGateway | undefined;
let apiSettings: ApiSettings | undefined;
let apiGateway: ApiModelGateway | undefined;
let sources: Sources | undefined;
let sourceGateway: SourceGateway | undefined;
let chatgpt: ChatGPTSettings | undefined;
let chatgptGateway: ChatGPTGateway | undefined;
let chatgptClosed = false;
let quitting = false;

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
  apiGateway = new ApiModelGateway(apiSettings!, { webContentsId: window.webContents.id, url: documentURL }, async () => {
    if (!window || window.isDestroyed()) return;
    const result = await dialog.showOpenDialog(window, { title: 'Import a trusted Pi models.json only (no auth, settings, or extensions)', properties: ['openFile'], filters: [{ name: 'Pi models configuration', extensions: ['json'] }] });
    return result.canceled ? undefined : result.filePaths[0];
  }, () => jobs?.revokeApiAuthority(), () => inventory!.snapshot().roots.map(root => root.path));
  knowledgeGateway = new KnowledgeGateway(knowledge!, { webContentsId: window.webContents.id, url: documentURL });
  sourceGateway = new SourceGateway(sources!, { webContentsId: window.webContents.id, url: documentURL });
  chatgptGateway = new ChatGPTGateway(chatgpt!, { webContentsId: window.webContents.id, url: documentURL }, url => shell.openExternal(url), () => jobs?.cancel());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { jobs?.cancel(); inventory?.cancel(); modelSettings?.cancel(); sourceGateway?.cancel(); chatgpt?.cancel(); });
  window.on('minimize', () => jobs?.lifecycle('minimize'));
  window.on('close', () => { jobs?.lifecycle('window-close'); inventory?.cancel(); modelSettings?.cancel(); sourceGateway?.cancel(); chatgpt?.cancel(); });
  window.on('closed', () => { knowledgeGateway = undefined; gateway = undefined; inventoryGateway = undefined; modelGateway = undefined; apiGateway = undefined; sourceGateway = undefined; chatgptGateway = undefined; window = undefined; });
  void window.loadURL(documentURL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('before-quit', event => {
    jobs?.lifecycle('quit'); inventory?.cancel(); modelSettings?.cancel(); sourceGateway?.cancel(); chatgpt?.cancel();
    if (chatgpt && !chatgptClosed) {
      event.preventDefault();
      if (quitting) return;
      quitting = true;
      chatgptGateway = undefined;
      // A refresh may already have rotated remotely. Wait for its bounded request and durable commit.
      void chatgpt.close().catch(() => {}).finally(() => { chatgptClosed = true; app.quit(); });
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { knowledge?.close(); conversations?.close(); inventory?.close(); modelSettings?.close(); apiSettings?.close(); sources?.close(); });
  void app.whenReady().then(() => {
    const stateDirectory = join(app.getPath('userData'), 'state');
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const database = join(stateDirectory, 'conversations.sqlite');
    conversations = new Conversations(database);
    chmodSync(database, 0o600);
    const inventoryDatabase = join(stateDirectory, 'inventory.sqlite');
    inventory = new Inventory(inventoryDatabase, notify);
    chmodSync(inventoryDatabase, 0o600);
    const sourceDatabase = join(stateDirectory, 'sources.sqlite');
    sources = new Sources(sourceDatabase, inventory);
    chmodSync(sourceDatabase, 0o600);
    const knowledgeDatabase = join(stateDirectory, 'knowledge.sqlite');
    knowledge = new Knowledge(knowledgeDatabase, sources, inventory, material => conversations!.assertClean(material));
    chmodSync(knowledgeDatabase, 0o600);
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
    const apiDatabase = join(stateDirectory, 'api-models.sqlite');
    apiSettings = new ApiSettings(apiDatabase, {
      available: () => process.platform === 'darwin' && safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value),
      decrypt: bytes => safeStorage.decryptString(Buffer.from(bytes)),
    }, runCredentialHelper(stateDirectory, { ...process.env }), { ...process.env }, amount => modelSettings!.reservePaidRequest(amount), notify);
    chmodSync(apiDatabase, 0o600);
    chatgpt = new ChatGPTSettings(new ChatGPTStore(join(stateDirectory, 'chatgpt.sqlite'), {
      available: () => process.platform === 'darwin' && safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value),
      decrypt: bytes => safeStorage.decryptString(Buffer.from(bytes)),
    }), new ChatGPTOAuth(url => shell.openExternal(url)), new ChatGPTProcess(() => utilityProcess.fork(join(output, 'chatgpt.js'), [], {
      serviceName: 'Athena ChatGPT test', env: {}, stdio: 'ignore', cwd: stateDirectory,
    })), notify);
    jobs = new LiveSupervisor(conversations, chatgpt, sources, inventory, () => utilityProcess.fork(join(output, 'live.js'), [], {
      serviceName: 'Athena ChatGPT conversation', env: {}, stdio: 'ignore', cwd: stateDirectory,
    }), notify, apiSettings, knowledge);
    ipcMain.handle('athena:knowledge', async (event, operation: unknown, payload: unknown) => {
      try {
        if (!knowledgeGateway || quitting) throw new Error();
        const result = await knowledgeGateway.dispatch({ webContentsId: event.sender.id, isMainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url ?? '' }, operation, payload);
        return { ok: true, result };
      } catch { return { ok: false, error: 'Knowledge inspection unavailable. Check source permissions and local storage, then retry.' }; }
    });
    ipcMain.handle('athena:api-models', async (event, operation: unknown, payload: unknown) => {
      try {
        if (!apiGateway || quitting) throw new Error();
        const result = await apiGateway.dispatch({ webContentsId: event.sender.id, isMainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url ?? '' }, operation, payload);
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: error instanceof ApiSettingsError ? error.message : 'API-key settings action rejected. Check the configuration, protected storage, and selected models.' };
      }
    });
    ipcMain.handle('athena:chatgpt', async (event, operation: unknown, payload: unknown) => {
      try {
        if (!chatgptGateway || quitting) throw new Error();
        const result = await chatgptGateway.dispatch({ webContentsId: event.sender.id, isMainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url ?? '' }, operation, payload);
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: error instanceof ChatGPTError ? error.message : 'ChatGPT action rejected. Finish the current operation and check the connection and selected model.' };
      }
    });
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
      } catch (error) {
        // Only application-authored errors, never SQL/native/provider exceptions.
        return { ok: false, error: error instanceof LiveError || error instanceof ChatGPTError || error instanceof ApiSettingsError || error instanceof ModelSettingsError ? error.message : 'Request rejected. Select a conversation and try again.' };
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
    ipcMain.handle('athena:sources', async (event, operation: unknown, payload: unknown) => {
      try {
        if (!sourceGateway) throw new Error('No workspace.');
        const result = await sourceGateway.dispatch({
          webContentsId: event.sender.id,
          isMainFrame: event.senderFrame === event.sender.mainFrame,
          url: event.senderFrame?.url ?? '',
        }, operation, payload);
        return { ok: true, result };
      } catch {
        return { ok: false, error: 'Source request rejected. Check folder permission, relative path, and limits; finish or cancel active browsing first.' };
      }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
    createWindow();
    // Discovery and freshness are local-only; never acquire provider access on launch.
    void inventory.scan().then(() => knowledge?.scan()).then(notify).catch(notify);
  }).catch(() => {
    dialog.showErrorBox('Athena could not start', 'Local state could not be opened. Check that your application data folder is writable, then restart Athena.');
    app.quit();
  });
}
