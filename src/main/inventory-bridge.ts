import { lstat, realpath } from 'node:fs/promises';
import { authorize, noPayload, object, text, type Caller } from './bridge';
import type { Inventory } from './inventory';
import { FOLDER_CONSENT, type InventoryWorkspace } from '../shared/inventory';

function pathText(value: unknown): string {
  // Paths are not trimmed: whitespace is a legal part of a directory name.
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\u0000')) throw new Error('Invalid path.');
  return value;
}

function repositoryName(value: unknown): string {
  text(value, 100);
  // Default names come from the filesystem, where surrounding whitespace is significant.
  return value as string;
}

/** The renderer cannot designate arbitrary paths: only a pending native picker selection. */
export class InventoryGateway {
  private pendingFolder: string | null = null;
  private changing = false;

  constructor(
    private readonly inventory: Inventory,
    private readonly owner: { webContentsId: number; url: string },
    private readonly chooseDirectory: () => Promise<string | undefined>,
  ) {}

  async dispatch(caller: Caller, operation: unknown, payload: unknown): Promise<InventoryWorkspace> {
    authorize(caller, this.owner);
    if (operation === 'snapshot') {
      noPayload(payload);
      return this.workspace();
    }
    if (operation === 'cancel') {
      noPayload(payload);
      this.inventory.cancel();
      return this.workspace();
    }
    if (this.changing || this.inventory.snapshot().discovery.status === 'running') throw new Error('Wait for discovery or cancel it first.');
    this.changing = true;
    try {
      switch (operation) {
        case 'chooseFolder': {
          noPayload(payload);
          this.pendingFolder = null;
          const selected = await this.chooseDirectory();
          if (selected) {
            const canonical = await realpath(selected);
            if (!(await lstat(canonical)).isDirectory()) throw new Error('Choose a directory.');
            this.pendingFolder = canonical;
          }
          break;
        }
        case 'consentFolder': {
          const input = object(payload, ['path', 'consent']);
          if (!this.pendingFolder || input.path !== this.pendingFolder || input.consent !== FOLDER_CONSENT) throw new Error('Folder consent is required.');
          await this.inventory.designate(this.pendingFolder, FOLDER_CONSENT);
          this.pendingFolder = null;
          break;
        }
        case 'dismissFolder':
          noPayload(payload);
          this.pendingFolder = null;
          break;
        case 'scan':
          noPayload(payload);
          // The inventory owns error reporting and cancellation; do not block IPC on traversal.
          void this.inventory.scan();
          break;
        case 'include': {
          const input = object(payload, ['root', 'location']);
          await this.inventory.include(pathText(input.root), pathText(input.location));
          break;
        }
        case 'register': {
          const input = object(payload, ['path', 'alias']);
          this.inventory.register(pathText(input.path), text(input.alias, 100));
          break;
        }
        case 'reconnect': {
          const input = object(payload, ['name', 'path']);
          this.inventory.reconnect(repositoryName(input.name), pathText(input.path));
          break;
        }
        case 'documentation': {
          const input = object(payload, ['name', 'locations']);
          if (!Array.isArray(input.locations) || input.locations.length > 50) throw new Error('Invalid documentation locations.');
          await this.inventory.documentation(repositoryName(input.name), input.locations.map(pathText));
          break;
        }
        default: throw new Error('Invalid inventory request.');
      }
      return this.workspace();
    } finally { this.changing = false; }
  }

  private workspace(): InventoryWorkspace {
    return { ...this.inventory.snapshot(), pendingFolder: this.pendingFolder };
  }
}
