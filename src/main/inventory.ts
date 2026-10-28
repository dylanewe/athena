import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { lstat, readdir, realpath, open } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { FOLDER_CONSENT, type DesignatedRoot, type Discovery, type InventorySnapshot, type Repository, type RepositoryCandidate } from '../shared/inventory';

// A worktree/submodule gitfile may point outside the root. Recognize it without following it.
async function isGitFile(path: string): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return /^gitdir: [^\r\n]+(?:\r?\n|$)/.test(buffer.toString('utf8', 0, bytesRead));
  } finally { await file.close(); }
}

const excludedDirectories = new Set(['node_modules', 'vendor', 'vendors', 'bower_components', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'venv', 'env', 'pods', 'carthage']);
function excluded(name: string): boolean { return name.startsWith('.') || excludedDirectories.has(name.toLowerCase()); }
function within(root: string, path: string): boolean { return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep); }
function relativeLocation(value: string): string {
  if (!value || isAbsolute(value) || value.includes('\u0000') || value.split('/').some(part => !part || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Use a relative directory inside the designated root; Git metadata cannot be included.');
  }
  return value;
}
// Recheck every component, including persisted roots, rather than trusting a lexical prefix.
async function safeDirectory(root: string, location = '.', allowMissing = false): Promise<string> {
  relativeLocation(location);
  if (await realpath(root) !== root) throw new Error('The designated root has moved or become a symlink.');
  let path = root;
  for (const part of ['.', ...location.split('/')]) {
    path = join(path, part);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Symlinks and non-directories cannot be included.');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return join(root, location);
      throw error;
    }
  }
  return path;
}

function filesystemFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return 'Permission denied. Check macOS folder access and rescan.';
  if (code === 'ENOENT') return 'Directory no longer exists. Restore it or designate its new location.';
  return 'Directory could not be inspected safely. Check for symlinks, moves, or unreadable files and rescan.';
}

const nameKey = (name: string) => name.normalize('NFC').toLowerCase();
function validName(name: string): boolean { return !!name.trim() && name.length <= 100 && !/[\u0000-\u001f/\\]/.test(name); }
interface DurableInventory { roots: DesignatedRoot[]; repositories: Repository[]; candidates: RepositoryCandidate[] }

/** Local metadata inventory only: no provider, agent, credentials, or repository writes. */
export class Inventory {
  private readonly db: DatabaseSync;
  private state: DurableInventory;
  private discovery: Discovery = { status: 'idle', visited: 0, current: '', nonGitFiles: 0, failures: [] };
  private closed = false;
  private cancelled = false;

  constructor(path: string, private readonly changed: () => void = () => {}) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS inventory (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value TEXT NOT NULL);`);
    const row = this.db.prepare('SELECT value FROM inventory WHERE singleton = 1').get();
    this.state = row ? JSON.parse(String(row.value)) as DurableInventory : { roots: [], repositories: [], candidates: [] };
  }

  snapshot(): InventorySnapshot {
    return structuredClone({ ...this.state, discovery: this.discovery });
  }

  async designate(path: string, consent: string): Promise<void> {
    this.requireIdle();
    if (consent !== FOLDER_CONSENT) throw new Error('Folder consent is required.');
    // Consent applies to the canonical path displayed by the native picker, never a new symlink target.
    const canonical = await safeDirectory(path);
    this.requireIdle();
    if (this.state.roots.some(root => root.path === canonical)) return;
    this.save({ ...this.state, roots: [...this.state.roots, { path: canonical, consent, acceptedAt: new Date().toISOString(), includedLocations: [] }] });
  }

  async include(rootPath: string, location: string): Promise<void> {
    this.requireIdle();
    const root = this.state.roots.find(item => item.path === rootPath);
    if (!root) throw new Error('Unknown designated root.');
    const path = await safeDirectory(root.path, location);
    this.requireIdle();
    const normalized = relative(root.path, path) || '.';
    const roots = this.state.roots.map(item => item === root ? { ...root, includedLocations: [...new Set([...root.includedLocations, normalized])] } : item);
    this.save({ ...this.state, roots });
  }

  async scan(): Promise<void> {
    this.requireIdle();
    this.cancelled = false;
    this.discovery = { status: 'running', visited: 0, current: '', nonGitFiles: 0, failures: [] };
    this.changed();
    const repositories: Repository[] = [];
    const visited = new Set<string>();
    const examined = new Set<string>();
    const includes = this.state.roots.flatMap(root => [root.path, ...root.includedLocations.map(location => join(root.path, location))]);
    const visit = async (root: DesignatedRoot, path: string, owner?: Repository, transit = false): Promise<void> => {
      if (this.cancelled || visited.has(path)) return;
      visited.add(path);
      try {
        this.discovery.current = path;
        this.discovery.visited++;
        this.changed();
        if (this.cancelled) return;
        await safeDirectory(root.path, relative(root.path, path) || '.');
        if (this.cancelled) return;
        const entries = await readdir(path, { withFileTypes: true });
        if (this.cancelled) return;
        const marker = entries.find(entry => entry.name === '.git');
        if (marker && (marker.isDirectory() || (marker.isFile() && await isGitFile(join(path, '.git'))))) {
          owner?.boundaries.push(path);
          owner = { name: basename(path), path, presence: 'present', documentationRoots: ['docs'], fileCount: 0, boundaries: [], examined: false };
          repositories.push(owner);
        }
        examined.add(path);
        for (const entry of entries) {
          if (this.cancelled) return;
          if (entry.name === '.git' || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            const child = join(path, entry.name);
            const explicit = includes.includes(child);
            const ancestor = includes.some(location => within(child, location));
            const skip = (transit || excluded(entry.name)) && !explicit;
            if (!skip || ancestor) await visit(root, child, owner, skip);
          } else if (!transit && entry.isFile()) {
            if (owner) owner.fileCount++;
            else this.discovery.nonGitFiles++;
          }
        }
      } catch (error) {
        this.discovery.failures.push({ path, message: filesystemFailure(error) });
        this.changed();
      }
    };
    try {
      // Outer roots first: overlapping designations must not count files twice or lose ownership.
      for (const root of [...this.state.roots].sort((a, b) => a.path.length - b.path.length)) await visit(root, root.path);
      if (this.closed) return;
      await this.reconcile(repositories, examined);
      this.discovery.status = this.cancelled ? 'cancelled' : 'complete';
    } catch {
      this.discovery.status = 'failed';
      this.discovery.failures.push({ path: '', message: 'Could not save inventory. Check local storage and rescan.' });
    }
    if (!this.closed) this.changed();
  }

  cancel(): void {
    this.cancelled = true;
  }

  async documentation(name: string, locations: string[]): Promise<void> {
    this.requireIdle();
    const repository = this.state.repositories.find(repo => repo.name === name);
    const root = repository && this.state.roots.find(item => within(item.path, repository.path));
    if (!repository || !root) throw new Error('Unknown repository.');
    await safeDirectory(root.path, relative(root.path, repository.path) || '.');
    for (const location of locations) await safeDirectory(repository.path, location, true);
    this.requireIdle();
    this.save({ ...this.state, repositories: this.state.repositories.map(repo => repo === repository ? { ...repo, documentationRoots: [...new Set(locations)] } : repo) });
  }

  register(path: string, alias: string): void {
    this.requireIdle();
    const candidate = this.state.candidates.find(item => item.path === path);
    const name = alias.trim();
    if (!candidate || candidate.presence !== 'present' || !validName(name) || this.state.repositories.some(repo => nameKey(repo.name) === nameKey(name))) {
      throw new Error('Choose a unique repository name (up to 100 characters, without slashes).');
    }
    const { reason: _, ...repository } = candidate;
    this.save({ ...this.state, repositories: [...this.state.repositories, { ...repository, name }], candidates: this.state.candidates.filter(item => item !== candidate) });
  }

  reconnect(name: string, path: string): void {
    this.requireIdle();
    const original = this.state.repositories.find(repo => repo.name === name && repo.presence === 'missing');
    const candidate = this.state.candidates.find(item => item.path === path);
    if (!original || !candidate || candidate.presence !== 'present') throw new Error('Choose a missing repository and a discovered location.');
    const { reason: _, ...repository } = candidate;
    this.save({ ...this.state,
      repositories: this.state.repositories.map(repo => repo === original ? { ...repository, name: original.name, documentationRoots: original.documentationRoots } : repo),
      candidates: this.state.candidates.filter(item => item !== candidate),
    });
  }

  private async reconcile(found: Repository[], visited: Set<string>): Promise<void> {
    const repositories: Repository[] = [];
    for (const previous of this.state.repositories) {
      const current = found.find(repo => repo.path === previous.path);
      if (current) repositories.push({ ...current, name: previous.name, documentationRoots: previous.documentationRoots });
      else {
        let presence: Repository['presence'] = !this.cancelled && visited.has(previous.path) ? 'missing' : 'unknown';
        const root = this.state.roots.find(item => within(item.path, previous.path));
        try { if (!this.cancelled && root) await safeDirectory(root.path, relative(root.path, previous.path) || '.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') presence = 'missing'; }
        repositories.push({ ...previous, presence });
      }
    }
    const candidates: RepositoryCandidate[] = [];
    for (const repository of found) {
      if (repositories.some(item => item.path === repository.path)) continue;
      const collision = !validName(repository.name) || repositories.some(item => nameKey(item.name) === nameKey(repository.name));
      if (collision || repositories.some(item => item.presence === 'missing') || this.state.candidates.some(item => item.path === repository.path)) {
        candidates.push({ ...repository, reason: collision ? 'collision' : 'connection' });
      } else repositories.push(repository);
    }
    if (this.cancelled) {
      for (const candidate of this.state.candidates) {
        if (!candidates.some(item => item.path === candidate.path)) candidates.push({ ...candidate, presence: 'unknown' });
      }
    }
    if (!this.closed) this.save({ ...this.state, repositories, candidates });
  }

  close(): void {
    this.cancel();
    if (!this.closed) { this.closed = true; this.db.close(); }
  }

  private requireIdle(): void {
    if (this.closed || this.discovery.status === 'running') throw new Error('Wait for discovery to finish or cancel it first.');
  }

  private save(state: DurableInventory): void {
    this.db.prepare('INSERT OR REPLACE INTO inventory(singleton, value) VALUES (1, ?)').run(JSON.stringify(state));
    this.state = state;
    this.changed();
  }
}
