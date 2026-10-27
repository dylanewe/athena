import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, Workspace } from './shared/contracts';

async function request(operation: string, payload?: unknown): Promise<Workspace> {
  const reply = await ipcRenderer.invoke('athena:request', operation, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.workspace;
}

const bridge: DesktopBridge = {
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
