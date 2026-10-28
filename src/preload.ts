import { contextBridge, ipcRenderer } from 'electron';
import type { InventoryWorkspace } from './shared/inventory';
import type { DesktopBridge, Workspace } from './shared/contracts';

async function request(operation: string, payload?: unknown): Promise<Workspace> {
  const reply = await ipcRenderer.invoke('athena:request', operation, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.workspace;
}

async function inventoryRequest(operation: string, payload?: unknown): Promise<InventoryWorkspace> {
  const reply = await ipcRenderer.invoke('athena:inventory', operation, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.inventory;
}

const bridge: DesktopBridge = {
  inventory: {
    snapshot: () => inventoryRequest('snapshot'),
    chooseFolder: () => inventoryRequest('chooseFolder'),
    consentFolder: (path, consent) => inventoryRequest('consentFolder', { path, consent }),
    dismissFolder: () => inventoryRequest('dismissFolder'),
    scan: () => inventoryRequest('scan'),
    cancel: () => inventoryRequest('cancel'),
    include: (root, location) => inventoryRequest('include', { root, location }),
    register: (path, alias) => inventoryRequest('register', { path, alias }),
    reconnect: (name, path) => inventoryRequest('reconnect', { name, path }),
    documentation: (name, locations) => inventoryRequest('documentation', { name, locations }),
  },
  workspace: () => request('workspace'),
  create: title => request('create', { title }),
  select: conversationId => request('select', { conversationId }),
  send: (conversationId, text) => request('send', { conversationId, text }),
  cancel: () => request('cancel'),
  onChange(listener) {
    // Do not leak the privileged IPC event or allow a renderer-selected channel.
    const notify = () => listener();
    ipcRenderer.on('athena:changed', notify);
    return () => ipcRenderer.removeListener('athena:changed', notify);
  },
};
contextBridge.exposeInMainWorld('athena', bridge);
