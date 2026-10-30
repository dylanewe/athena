import { runLiveAgent } from './live-agent';
import type { LiveParentMessage, LiveRequest } from '../shared/live';

const parent = process.parentPort;
if (!parent) throw new Error('Athena live conversations require an Electron utility process.');
let started = false, next = 0;
const pending = new Map<number, (value: Extract<LiveParentMessage, { type: 'reply' }>) => void>();
function rpc(request: Omit<Extract<LiveRequest, { type: 'source' }>, 'id'> | Omit<Extract<LiveRequest, { type: 'access' }>, 'id'>) {
  return new Promise<Extract<LiveParentMessage, { type: 'reply' }>>((resolve, reject) => {
    const id = ++next;
    pending.set(id, value => value.error ? reject(new Error('Athena rejected the operation.')) : resolve(value));
    parent!.postMessage({ ...request, id });
  });
}
parent.on('message', ({ data }: { data: LiveParentMessage }) => {
  if (data.type === 'reply') { const resolve = pending.get(data.id); pending.delete(data.id); resolve?.(data); return; }
  if (data.type !== 'start' || started) return;
  started = true;
  void runLiveAgent(data.job, {
    access: async () => { const reply = await rpc({ type: 'access' }); if (!reply.token) throw new Error(); return reply.token; },
    source: async (operation, input) => { const reply = await rpc({ type: 'source', operation, input }); if (!reply.source) throw new Error(); return reply.source; },
    progress: (text, activity) => parent.postMessage({ type: 'progress', text, activity }),
    reportUsage: (request, usage) => parent.postMessage({ type: 'usage', request, usage }),
  }, new AbortController().signal).then(result => parent.postMessage({ type: 'result', result })).catch(() => {
    parent.postMessage({ type: 'result', result: { status: 'failed', text: '', history: [], usageComplete: false, requests: 0 } });
  });
});
