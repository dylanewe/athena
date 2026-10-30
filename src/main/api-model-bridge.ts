import { open, realpath } from 'node:fs/promises';
import { basename, dirname, sep } from 'node:path';
import { authorize, noPayload, object, type Caller } from './bridge';
import type { ApiSettings } from './api-settings';
import { ApiSettingsError } from './pi-model-config';
import type { ApiSettingsSnapshot, ConversationRoute } from '../shared/api-models';

/** Only a native picker (explicit action) can name an import file; renderer cannot read arbitrary paths. */
export async function importModelsFile(path: string, sourceRoots: string[] = []): Promise<string> {
  const canonical = await realpath(path);
  const roots = await Promise.all(sourceRoots.map(root => realpath(root)));
  if (basename(dirname(canonical)) === '.pi' || roots.some(root => canonical === root || canonical.startsWith(root + sep))) throw new ApiSettingsError('Repository-local configuration cannot be imported. Choose your separate trusted Pi user models.json.');
  const file = await open(canonical, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 256 * 1024) throw new ApiSettingsError('Choose a models.json file no larger than 256 KiB.');
    const buffer = Buffer.alloc(256 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 256 * 1024) throw new ApiSettingsError('Model import exceeds 256 KiB.');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
export class ApiModelGateway {
  constructor(private readonly settings: ApiSettings, private readonly owner: { webContentsId: number; url: string }, private readonly chooseFile: () => Promise<string | undefined>, private readonly revoked: () => void = () => {}, private readonly sourceRoots: () => string[] = () => []) {}
  async dispatch(caller: Caller, operation: unknown, payload: unknown): Promise<ApiSettingsSnapshot> {
    authorize(caller, this.owner);
    switch (operation) {
      case 'snapshot': noPayload(payload); return this.settings.snapshot();
      case 'configure': {
        const p = object(payload, ['json']);
        if (typeof p.json !== 'string') throw new Error();
        return this.settings.configure(p.json);
      }
      case 'importModels': {
        noPayload(payload);
        const path = await this.chooseFile();
        return path ? this.settings.configure(await importModelsFile(path, this.sourceRoots())) : this.settings.snapshot();
      }
      case 'select': {
        const p = object(payload, ['route', 'conversation', 'investigator']);
        if (typeof p.route !== 'string' || typeof p.conversation !== 'string' || typeof p.investigator !== 'string') throw new Error();
        return this.settings.select(p.route as ConversationRoute, p.conversation, p.investigator);
      }
      case 'credential': {
        const p = object(payload, ['provider', 'key']);
        if (typeof p.provider !== 'string' || typeof p.key !== 'string') throw new Error();
        return this.settings.credential(p.provider, p.key);
      }
      case 'revokeCredential': {
        const p = object(payload, ['provider']); if (typeof p.provider !== 'string') throw new Error();
        const result = this.settings.revokeCredential(p.provider); this.revoked(); return result;
      }
      case 'approveDestination': case 'approveHelper': {
        const p = object(payload, ['id', 'approved']);
        if (typeof p.id !== 'string' || typeof p.approved !== 'boolean') throw new Error();
        const result = operation === 'approveDestination' ? this.settings.approveDestination(p.id, p.approved) : this.settings.approveHelper(p.id, p.approved);
        if (!p.approved) this.revoked(); return result;
      }
      default: throw new Error('Invalid API-key settings operation.');
    }
  }
}
