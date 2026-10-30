import { authorize, noPayload, object, type Caller } from './bridge';
import type { ChatGPTSettings } from './chatgpt-settings';
import { CHATGPT_USAGE_URL, type ChatGPTSnapshot } from '../shared/chatgpt';
export class ChatGPTGateway {
  constructor(private readonly settings: ChatGPTSettings, private readonly owner: { webContentsId: number; url: string }, private readonly openExternal: (url: string) => Promise<void>, private readonly cancelConversation: () => void = () => {}) {}
  dispatch(caller: Caller, operation: unknown, payload: unknown): ChatGPTSnapshot | Promise<void> {
    authorize(caller, this.owner);
    if (operation === 'selectModel') {
      const input = object(payload, ['id']);
      if (typeof input.id !== 'string' || !input.id || input.id.length > 256) throw new Error('Invalid model selection.');
      return this.settings.selectModel(input.id);
    }
    noPayload(payload);
    switch (operation) {
      case 'snapshot': return this.settings.snapshot();
      case 'connect': return this.settings.connect();
      case 'enablePlan': return this.settings.connect(true);
      case 'refreshModels': return this.settings.refreshModels();
      case 'test': return this.settings.test();
      case 'cancel': this.cancelConversation(); return this.settings.cancel();
      case 'disconnect': this.cancelConversation(); return this.settings.disconnect();
      case 'forget': return this.settings.forget();
      case 'openUsage': return this.openExternal(CHATGPT_USAGE_URL);
      default: throw new Error('Invalid ChatGPT operation.');
    }
  }
}
