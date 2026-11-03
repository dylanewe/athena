export const PURGE_CONFIRMATION = 'Permanently delete associated local data';
export const FOLDER_CONSENT = 'Eligible material throughout this folder, including future repositories and non-Git documents, may be investigated and sent to providers you explicitly approve. Repository inventory and documentation starting directories organize knowledge; they do not restrict access. Folder consent does not approve a provider, secret access, environment access, or paid work.';

export function folderGranted(roots: DesignatedRoot[], path: string): boolean {
  return roots.some(root => root.path === path && !root.revokedAt && root.consent === FOLDER_CONSENT && !!root.acceptedAt);
}

export interface DesignatedRoot {
  path: string;
  revokedAt?: string;
  purgePending?: boolean;
  purgedAt?: string;
  consent: string;
  acceptedAt: string;
  includedLocations: string[];
}
export interface Repository {
  name: string;
  path: string;
  presence: 'present' | 'missing' | 'unknown';
  documentationRoots: string[];
  boundaries: string[];
  fileCount: number;
  examined: false;
}
export interface Discovery {
  status: 'idle' | 'running' | 'complete' | 'cancelled' | 'failed';
  visited: number;
  current: string;
  nonGitFiles: number;
  failures: { path: string; message: string }[];
}
export interface RepositoryCandidate extends Repository {
  reason: 'collision' | 'connection';
}
export interface InventoryWorkspace extends InventorySnapshot {
  pendingFolder: string | null;
}
export interface InventoryBridge {
  snapshot(): Promise<InventoryWorkspace>;
  chooseFolder(): Promise<InventoryWorkspace>;
  consentFolder(path: string, consent: string): Promise<InventoryWorkspace>;
  dismissFolder(): Promise<InventoryWorkspace>;
  revoke(path: string): Promise<InventoryWorkspace>;
  purge(path: string, confirmation: string): Promise<InventoryWorkspace>;
  scan(): Promise<InventoryWorkspace>;
  cancel(): Promise<InventoryWorkspace>;
  include(root: string, location: string): Promise<InventoryWorkspace>;
  register(path: string, alias: string): Promise<InventoryWorkspace>;
  reconnect(name: string, path: string): Promise<InventoryWorkspace>;
  documentation(name: string, locations: string[]): Promise<InventoryWorkspace>;
}
export interface InventorySnapshot {
  roots: DesignatedRoot[];
  repositories: Repository[];
  candidates: RepositoryCandidate[];
  discovery: Discovery;
}
