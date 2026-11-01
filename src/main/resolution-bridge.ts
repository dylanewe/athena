import { authorize, type Caller } from './bridge';
import type { Resolutions } from './resolutions';
import type { ResolutionRead, ResolutionWrite } from '../shared/resolutions';

/** User-only annotation boundary. Workers have no IPC route to this gateway. */
export class ResolutionGateway {
  constructor(private readonly resolutions: Resolutions, private readonly owner: { webContentsId: number; url: string }) {}
  dispatch(caller: Caller, operation: unknown, payload: unknown) {
    authorize(caller, this.owner);
    if (operation === 'read') return this.resolutions.read(payload as ResolutionRead);
    if (operation === 'write') return this.resolutions.write(payload as ResolutionWrite);
    throw new Error('Invalid annotation request.');
  }
}
