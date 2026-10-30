import { CHATGPT_TEST_TIMEOUT, parseChatGPTResult, type ChatGPTResult } from '../shared/chatgpt';
import type { ChatGPTProvider } from './chatgpt-settings';
export interface ChatGPTWorker {
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'exit' | 'spawn', listener: () => void): unknown;
  postMessage(value: { token: string; model: string }): void;
  kill(): boolean;
}
export class ChatGPTProcess implements ChatGPTProvider {
  constructor(private readonly spawn: () => ChatGPTWorker) {}
  start(token: string, model: string): ReturnType<ChatGPTProvider['start']> {
    let worker: ChatGPTWorker | undefined;
    let settled = false;
    let resolve!: (result: ChatGPTResult) => void;
    const result = new Promise<ChatGPTResult>(done => { resolve = done; });
    const finish = (value: ChatGPTResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker?.kill(); } catch { /* Never expose native errors. */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ status: 'failed', reason: 'cancelled' }), CHATGPT_TEST_TIMEOUT);
    try {
      worker = this.spawn();
      worker.on('spawn', () => { if (settled) { try { worker?.kill(); } catch { /* Already gone. */ } } });
      worker.on('message', value => finish(parseChatGPTResult(value)));
      worker.on('exit', () => finish({ status: 'failed', reason: 'unavailable' }));
      worker.postMessage({ token, model });
    } catch { finish({ status: 'failed', reason: 'unavailable' }); }
    return { result, cancel: () => finish({ status: 'failed', reason: 'cancelled' }) };
  }
}
