import { chatgptExchange } from './chatgpt-exchange';
import { CHATGPT_TEST_TIMEOUT } from '../shared/chatgpt';
const parent = process.parentPort;
if (!parent) throw new Error('ChatGPT test worker requires an Electron parent.');
parent.once('message', (event: { data: unknown }) => {
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || Object.keys(data).some(key => key !== 'token' && key !== 'model') || typeof data.token !== 'string' || typeof data.model !== 'string') {
    parent.postMessage({ status: 'failed', reason: 'protocol' });
    return;
  }
  void chatgptExchange(data.token, data.model, AbortSignal.timeout(CHATGPT_TEST_TIMEOUT)).then(
    result => parent.postMessage(result), () => parent.postMessage({ status: 'failed', reason: 'unavailable' }),
  );
});
