import { contextBridge, ipcRenderer } from 'electron';
import type { ApiSettingsSnapshot } from './shared/api-models';
import type { ChatGPTSnapshot } from './shared/chatgpt';
import type { SourceResult, SourceException } from './shared/sources';
import type { InventoryWorkspace } from './shared/inventory';
import type { ModelWorkspace } from './shared/models';
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

async function modelRequest(operation: string, payload?: unknown): Promise<ModelWorkspace> {
  const reply = await ipcRenderer.invoke('athena:models', operation, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.models;
}

async function sourceRequest(operation: string, payload?: unknown): Promise<unknown> {
  const reply = await ipcRenderer.invoke('athena:sources', operation, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

async function chatgptRequest(operation: string, payload?: unknown): Promise<ChatGPTSnapshot> {
  const reply = await ipcRenderer.invoke('athena:chatgpt', operation, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

async function apiModelRequest(operation: string, payload?: unknown): Promise<ApiSettingsSnapshot> {
  const reply = await ipcRenderer.invoke('athena:api-models', operation, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

const bridge: DesktopBridge = {
  knowledge: {
    retrieve: async request => {
      const reply = await ipcRenderer.invoke('athena:knowledge', 'retrieve', request);
      if (!reply.ok) throw new Error(reply.error);
      return reply.result;
    },
  },
  apiModels: {
    snapshot: () => apiModelRequest('snapshot'),
    configure: json => apiModelRequest('configure', { json }),
    importModels: () => apiModelRequest('importModels'),
    select: (route, conversation, investigator) => apiModelRequest('select', { route, conversation, investigator }),
    credential: (provider, key) => apiModelRequest('credential', { provider, key }),
    revokeCredential: provider => apiModelRequest('revokeCredential', { provider }),
    approveDestination: (id, approved) => apiModelRequest('approveDestination', { id, approved }),
    approveHelper: (id, approved) => apiModelRequest('approveHelper', { id, approved }),
  },
  chatgpt: {
    snapshot: () => chatgptRequest('snapshot'),
    connect: () => chatgptRequest('connect'),
    enablePlan: () => chatgptRequest('enablePlan'),
    refreshModels: () => chatgptRequest('refreshModels'),
    selectModel: id => chatgptRequest('selectModel', { id }),
    test: () => chatgptRequest('test'),
    cancel: () => chatgptRequest('cancel'),
    disconnect: () => chatgptRequest('disconnect'),
    forget: () => chatgptRequest('forget'),
    openUsage: async () => { await chatgptRequest('openUsage'); },
  },
  sources: {
    run: (operation, input) => sourceRequest(operation, input) as Promise<SourceResult>,
    cancel: () => sourceRequest('cancel') as Promise<void>,
    exceptions: () => sourceRequest('exceptions') as Promise<SourceException[]>,
    exception: (root, path, include) => sourceRequest('exception', { root, path, include }) as Promise<SourceException[]>,
  },
  models: {
    snapshot: () => modelRequest('snapshot'),
    saveKey: key => modelRequest('saveKey', { key }),
    consent: text => modelRequest('consent', { text }),
    revokeConsent: () => modelRequest('revokeConsent'),
    test: () => modelRequest('test'),
    cancel: () => modelRequest('cancel'),
  },
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
  select: conversationId => request('select', { conversationId }),
  send: (conversationId, text) => request('send', { conversationId, text }),
  cancel: () => request('cancel'),
  retry: messageId => request('retry', { messageId }),
  environment: (id, action) => request('environment', { id, action }),
  onChange(listener) {
    // Do not leak the privileged IPC event or allow a renderer-selected channel.
    const notify = () => listener();
    ipcRenderer.on('athena:changed', notify);
    return () => ipcRenderer.removeListener('athena:changed', notify);
  },
};
contextBridge.exposeInMainWorld('athena', bridge);
