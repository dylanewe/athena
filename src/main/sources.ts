import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ignore, { type Ignore } from 'ignore';
import type { Inventory } from './inventory';
import { FOLDER_CONSENT } from '../shared/inventory';
import { suspectedSecret } from './secret-check';
import { SOURCE_LIMITS as L, SOURCE_WARNING, type SourceCitation, type SourceEntry, type SourceException, type SourceOperation, type SourceRequest, type SourceResult } from '../shared/sources';

const skipped = new Set(['node_modules', 'vendor', 'vendors', 'bower_components', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'venv', 'env', 'pods', 'carthage']);
const generated = /(?:\.min\.(?:js|css)|\.map|\.lock|\.generated\.[^.]+|\.g\.[^.]+|^package-lock\.json|^npm-shrinkwrap\.json|^pnpm-lock\.yaml)$/i;
const credentialFormat = /\.(?:pem|key|p12|pfx|keystore|jks|tfstate|tfvars)$/i;
const binary = /\.(?:pdf|png|jpe?g|gif|webp|ico|bmp|heic|svgz|zip|gz|tar|7z|rar|exe|dll|so|dylib|o|a|class|jar|wasm|woff2?|ttf|mp[34]|mov|sqlite3?|db|pyc)$/i;
const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
class Denied extends Error { constructor(readonly reason: string, readonly overridable = false, readonly environment = false) { super(reason); } }
class Stopped extends Error { constructor(readonly reason: string) { super(reason); } }
function location(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || isAbsolute(value) || /[\u0000-\u001f\\]/.test(value) ||
      (value !== '.' && value.split('/').some(part => !part || part === '.' || part === '..'))) throw new Denied('Use a relative path inside a designated folder.');
  return value;
}
function protectedName(path: string): boolean {
  const parts = path.toLowerCase().split('/');
  if (parts.some(part => ['.git', '.ssh', '.aws', '.gnupg', '.kube', '.azure'].includes(part))) return true;
  // Examples are recognizable by filename, never by an instruction inside the file.
  if (parts.some(name => (/^(?:\.env(?:[._-].*)?|\.envrc(?:[._-].*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc|_netrc|\.git-credentials|\.gitconfig|\.credentials|\.s3cfg|\.boto|\.dockercfg|\.htpasswd|\.pgpass|\.my\.cnf|service[-_]?account(?:[-_]?key)?\.json|credentials(?:[._-].*)?|secrets?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/.test(name) || credentialFormat.test(name)) && !environmentExample(name))) return true;
  return parts.includes('.docker') && parts.at(-1) === 'config.json';
}
function environmentExample(name: string): boolean {
  return /^(?:\.env(?:[._-].*)?|\.envrc(?:[._-].*)?|\.npmrc|credentials[._-].*|secrets?[._-].*|.*\.tfvars)[._-](?:example|sample|template|dist)$/i.test(name);
}
interface Budget {
  deadline: number; signal?: AbortSignal; scanned: number; bytes: number; output: number;
  check(): void;
}
interface Access { absolute: string; directory: boolean; owner: string | null }
export interface EnvironmentAccess { root: string; path: string; valid(): boolean }
function actualEnvironment(path: string): boolean {
  return /^(?:\.env|\.envrc)(?:[._-].*)?$/i.test(basename(path)) && !environmentExample(basename(path)) && !credentialFormat.test(path);
}

/** Shared UI/tool boundary. Never executes Git, repository code, generators, or network operations. */
export class Sources {
  private readonly db: DatabaseSync;
  private includes: SourceException[];
  constructor(path: string, private readonly inventory: Pick<Inventory, 'snapshot'>) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS source_policy (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value TEXT NOT NULL)');
    const row = this.db.prepare('SELECT value FROM source_policy WHERE singleton = 1').get();
    this.includes = row ? JSON.parse(String(row.value)) as SourceException[] : [];
  }
  exceptions(): SourceException[] { return structuredClone(this.includes); }
  close(): void { this.db.close(); }

  async exception(root: string, path: string, include: boolean): Promise<SourceException[]> {
    this.root(root); location(path);
    if (protectedName(`${root}/${path}`)) throw new Denied('Credential files and Git internals cannot be included.');
    await this.safePath(root, path);
    const next = this.includes.filter(item => item.root !== root || item.path !== path);
    if (include) next.push({ root, path });
    this.db.prepare('INSERT OR REPLACE INTO source_policy VALUES (1, ?)').run(JSON.stringify(next));
    this.includes = next;
    return this.exceptions();
  }

  async run(operation: SourceOperation, input: SourceRequest, signal?: AbortSignal, permission?: EnvironmentAccess, trackInspected = false): Promise<SourceResult> {
    if (!['list', 'search', 'read'].includes(operation)) throw new Denied('Unsupported source operation.');
    const root = this.root(input.root);
    const path = location(input.path);
    if (operation === 'search' && (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200 || /[\u0000-\u001f]/.test(input.query))) throw new Denied('Use a literal search of 1–200 characters.');
    const start = input.start ?? 1, end = input.end ?? start + L.lines - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= L.lines || end > 1_000_000) throw new Denied('Read at most 200 lines, using positive line numbers.');
    let timedOut = false;
    const budget: Budget = {
      deadline: performance.now() + L.milliseconds, signal, scanned: 0, bytes: 0, output: 1024,
      check() {
        if (this.signal?.aborted || (permission && !permission.valid())) throw new Stopped('cancelled');
        if (timedOut || performance.now() >= this.deadline) throw new Stopped('Time limit reached.');
      },
    };
    const result: SourceResult = { entries: [], status: 'complete', scanned: 0, bytesRead: 0, warning: SOURCE_WARNING };
    const push = (entry: SourceEntry) => {
      budget.check();
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (result.entries.length >= L.results || budget.output + bytes > L.outputBytes) throw new Stopped('Result or output-byte limit reached.');
      result.entries.push(entry); budget.output += bytes;
    };
    const inspect = async (name: string, depth: number): Promise<void> => {
      budget.check();
      if (++budget.scanned > L.entries) throw new Stopped('Entry limit reached.');
      if (depth > L.depth) throw new Stopped('Directory depth limit reached.');
      let access: Access;
      try { access = await this.access(root, name, budget, permission); }
      catch (error) {
        if (error instanceof Stopped) throw error;
        push({ path: name, kind: 'file', reason: error instanceof Denied ? error.reason : 'Unavailable or unsafe path.', overridable: error instanceof Denied && error.overridable, ...(error instanceof Denied && error.environment ? { environment: true } : {}) });
        return;
      }
      if (access.directory) {
        if (operation === 'read') { push({ path: name, kind: 'directory', reason: 'Choose a text file for range reads.' }); return; }
        if (name !== path) push({ path: name, kind: 'directory' });
        budget.check();
        const dir = await opendir(access.absolute);
        try {
          while (true) {
            budget.check();
            const entry = await dir.read();
            if (!entry) break;
            await inspect(name === '.' ? entry.name : `${name}/${entry.name}`, depth + 1);
          }
        } finally { await dir.close(); }
        return;
      }
      if (operation === 'list') { push({ path: name, kind: 'file' }); return; }
      try {
        const content = await this.text(root, name, budget, L.fileBytes);
        if (/^\s*(?:\/\*[\s\S]{0,300})?[^\n]*(?:@generated|automatically generated|do not edit)/im.test(content.slice(0, 1024)) && !this.included(root, name)) throw new Denied('Generated material (default exclusion).', true);
        const ephemeral = actualEnvironment(name) && permission?.root === root && permission.path === name && permission.valid();
        if (!ephemeral && suspectedSecret(content)) throw new Denied('Suspected secret; content withheld.');
        const lines = content.split(/\r?\n/);
        const identity = createHash('sha256').update(content).digest('hex');
        const revision = access.owner ? await this.revision(root, access.owner, budget) : null;
        const repository = access.owner ? {
          name: this.inventory.snapshot().repositories.find(repo => repo.path === access.owner)?.name ?? basename(access.owner),
          path: relative(root, access.owner) || '.',
        } : null;
        const beforeEntries = result.entries.length;
        const excerpt = (first: number, last: number) => {
          const value = lines.slice(first - 1, last).join('\n');
          const max = Math.min(16 * 1024, L.outputBytes - budget.output - 2048);
          if (Buffer.byteLength(value) > max) throw new Denied('Excerpt exceeds output-byte limit; request a smaller line range.');
          const citation: SourceCitation = { folder: root, repository, path: name, start: first, end: last, revision, contentIdentity: `sha256:${identity}` };
          push({ path: name, kind: 'file', citation, text: value, ...(ephemeral ? { ephemeral: true } : {}) });
        };
        if (operation === 'read') {
          if (start > lines.length) push({ path: name, kind: 'file', reason: 'Requested range is past end of file.' });
          else excerpt(start, Math.min(end, lines.length));
        } else {
          for (let index = 0; index < lines.length; index++) {
            budget.check();
            if (lines[index].toLowerCase().includes(input.query!.toLowerCase())) excerpt(index + 1, index + 1);
          }
        }
        // Cited matches already carry an identity. Retain negative search dependencies too.
        if (trackInspected && !result.entries.slice(beforeEntries).some(entry => entry.citation)) {
          const inspected = { folder: root, repository, path: name, revision, contentIdentity: `sha256:${identity}` };
          const identityBytes = Buffer.byteLength(JSON.stringify(inspected));
          if ((result.inspectedFiles?.length ?? 0) >= L.results || budget.output + identityBytes > L.outputBytes) throw new Stopped('Inspected-file identity limit reached.');
          (result.inspectedFiles ??= []).push(inspected); budget.output += identityBytes;
        }
      } catch (error) {
        if (error instanceof Stopped) throw error;
        push({ path: name, kind: 'file', reason: error instanceof Denied ? error.reason : 'File unavailable or changed during read.', overridable: error instanceof Denied && error.overridable });
      }
    };
    let stop!: (error: Stopped) => void;
    const stopped = new Promise<never>((_resolve, reject) => { stop = reject; });
    const abort = () => stop(new Stopped('cancelled'));
    const timer = setTimeout(() => { timedOut = true; stop(new Stopped('Time limit reached.')); }, L.milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    try { await Promise.race([inspect(path, 0), stopped]); }
    catch (error) {
      result.status = error instanceof Stopped && error.reason === 'cancelled' ? 'cancelled' : 'truncated';
      result.reason = error instanceof Stopped ? error.reason : 'Some paths could not be inspected safely.';
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    result.scanned = Math.min(budget.scanned, L.entries);
    result.bytesRead = budget.bytes;
    return result;
  }

  private root(path: string): string {
    if (!this.inventory.snapshot().roots.some(root => root.path === path && root.consent === FOLDER_CONSENT && root.acceptedAt)) throw new Denied('Folder permission required.');
    return path;
  }
  private included(root: string, path: string): boolean {
    return this.includes.some(item => item.root === root && (item.path === '.' || path === item.path || path.startsWith(item.path + '/')));
  }
  /** Reject every symlink component, not only an escaped final target. */
  private async safePath(root: string, path: string): Promise<string> {
    if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Denied('Designated folder moved or became a symlink.');
    let absolute = root;
    for (const part of path === '.' ? [] : path.split('/')) {
      absolute = join(absolute, part);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Denied('Symlinks are not followed.');
    }
    if (!within(root, await realpath(absolute))) throw new Denied('Outside designated folder.');
    return absolute;
  }
  private async marker(path: string): Promise<boolean> {
    try { const stat = await lstat(join(path, '.git')); return stat.isDirectory() || stat.isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private async access(root: string, path: string, budget: Budget, permission?: EnvironmentAccess): Promise<Access> {
    budget.check();
    const environment = actualEnvironment(path) && !protectedName(`${root}/${path.split('/').slice(0, -1).join('/')}`);
    if (protectedName(`${root}/${path}`) && !environment) throw new Denied('Environment/credential file or Git internals are protected.');
    const absolute = await this.safePath(root, path);
    const stat = await lstat(absolute);
    const approved = environment && stat.isFile() && permission?.root === root && permission.path === path && permission.valid();
    if (environment && !approved) throw new Denied('Actual environment file is protected; current-investigation permission required.', false, stat.isFile() && stat.size <= L.fileBytes);
    if (!stat.isDirectory() && !stat.isFile()) throw new Denied('Only regular text files and directories are supported.');
    // An exact file exception may traverse excluded ancestors, but never admits sibling files.
    const override = approved || this.included(root, path) || (stat.isDirectory() && this.includes.some(item => item.root === root && (path === '.' || item.path.startsWith(path + '/'))));
    let owner: string | null = null;
    const rules: { base: string; matcher: Ignore }[] = [];
    const parts = path === '.' ? [] : path.split('/');
    let directory = root;
    for (let index = 0; index <= parts.length; index++) {
      budget.check();
      if (await this.marker(directory)) { owner = directory; rules.length = 0; }
      if (index > 0 && !override) {
        if (parts[index - 1].startsWith('.') || skipped.has(parts[index - 1].toLowerCase())) throw new Denied('Hidden/vendor/generated directory (default exclusion).', true);
      }
      const ignoreText = await this.optionalText(root, join(directory, '.gitignore'), budget);
      if (ignoreText) rules.push({ base: directory, matcher: ignore().add(ignoreText) });
      if (owner === directory) {
        const info = await this.optionalText(root, join(directory, '.git/info/exclude'), budget);
        if (info) rules.push({ base: directory, matcher: ignore().add(info) });
      }
      if (index === parts.length) break;
      const next = join(directory, parts[index]);
      const isDirectory = index < parts.length - 1 || stat.isDirectory();
      if (!override) {
        // A negative rule in a deeper .gitignore can override a parent's rule for a file.
        let ignored = false;
        for (const rule of rules) {
          const tested = rule.matcher.test(relative(rule.base, next) + (isDirectory ? '/' : ''));
          if (tested.ignored) ignored = true;
          else if (tested.unignored) ignored = false;
        }
        if (ignored) throw new Denied('Ignored by local Git ignore rules (default exclusion).', true);
      }
      if (!isDirectory) break;
      directory = next;
    }
    if (!stat.isDirectory()) {
      const name = basename(path);
      if (binary.test(name)) throw new Denied('Unsupported binary/media format.');
      if (!approved && !this.included(root, path) && (generated.test(name) || (name.startsWith('.') && !environmentExample(name)))) throw new Denied('Hidden/generated file (default exclusion).', true);
      if (stat.size > L.fileBytes) throw new Denied('File exceeds 256 KiB input limit; unsupported without a complete secret check.');
    }
    return { absolute, directory: stat.isDirectory(), owner };
  }
  /** Fixed, bounded local metadata only; no external gitdir/config/global-ignore traversal. */
  private async optionalText(root: string, absolute: string, budget: Budget): Promise<string | null> {
    if (!within(root, absolute)) return null;
    try { return await this.text(root, relative(root, absolute), budget, 32 * 1024); }
    catch (error) {
      if (error instanceof Stopped) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw new Denied('Safety metadata unavailable or over limit; content withheld.');
    }
  }
  private async text(root: string, path: string, budget: Budget, max: number): Promise<string> {
    budget.check();
    const absolute = await this.safePath(root, path);
    const before = await lstat(absolute);
    if (!before.isFile() || before.size > max) throw new Denied('Unsupported or oversized input.');
    if (budget.bytes + before.size + 1 > L.totalBytes) throw new Stopped('Input-byte limit reached.');
    budget.check();
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > max) throw new Denied('File changed during access check.');
      await this.safePath(root, path);
      budget.check();
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        budget.check();
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        budget.bytes += bytesRead;
        if (!bytesRead) break;
        length += bytesRead;
      }
      budget.check();
      const after = await file.stat();
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Denied('File changed during read; retry.');
      const data = buffer.subarray(0, length);
      if (data.includes(0) || data.some(byte => byte < 9 || (byte > 13 && byte < 32))) throw new Denied('Unsupported binary input.');
      try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
      catch { throw new Denied('Unsupported encoding; UTF-8 text required.'); }
    } finally { await file.close(); }
  }
  private async revision(root: string, owner: string, budget: Budget): Promise<string | null> {
    // Worktree/submodule pointers can leave the consented root: never follow them.
    const head = (await this.optionalText(root, join(owner, '.git/HEAD'), budget))?.trim();
    if (!head) return null;
    if (/^[a-f0-9]{40,64}$/.test(head)) return head;
    const ref = /^ref: (refs\/[A-Za-z0-9_./-]+)$/.exec(head)?.[1];
    if (!ref || ref.split('/').some(part => !part || part === '..' || part === '.')) return null;
    const value = (await this.optionalText(root, join(owner, '.git', ref), budget))?.trim();
    if (value && /^[a-f0-9]{40,64}$/.test(value)) return value;
    const packed = await this.optionalText(root, join(owner, '.git/packed-refs'), budget);
    return packed?.split('\n').find(line => line.endsWith(` ${ref}`))?.match(/^([a-f0-9]{40,64}) /)?.[1] ?? null;
  }
}
