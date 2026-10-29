import { authorize, noPayload, object, type Caller } from './bridge';
import type { ModelSettings } from './model-settings';
import type { ModelWorkspace } from '../shared/models';

export class ModelGateway {
  constructor(private readonly settings: ModelSettings, private readonly owner: { webContentsId: number; url: string }) {}

  dispatch(caller: Caller, operation: unknown, payload: unknown): ModelWorkspace {
    authorize(caller, this.owner);
    switch (operation) {
      case 'snapshot': noPayload(payload); return this.settings.snapshot();
      case 'saveKey': {
        const input = object(payload, ['key']);
        if (typeof input.key !== 'string') throw new Error('Invalid key entry.');
        return this.settings.saveKey(input.key);
      }
      case 'consent': {
        const input = object(payload, ['text']);
        if (typeof input.text !== 'string') throw new Error('Invalid provider permission.');
        return this.settings.consent(input.text);
      }
      case 'revokeConsent': noPayload(payload); return this.settings.revokeConsent();
      case 'test': noPayload(payload); return this.settings.testConnection();
      case 'cancel': noPayload(payload); return this.settings.cancel();
      default: throw new Error('Invalid model settings request.');
    }
  }
}
