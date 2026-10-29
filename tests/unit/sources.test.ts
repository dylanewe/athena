import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Inventory } from '../../src/main/inventory';
import { Sources } from '../../src/main/sources';
import { FOLDER_CONSENT } from '../../src/shared/inventory';
import { SOURCE_LIMITS as L } from '../../src/shared/sources';
import { sourceTools } from '../../src/main/source-tools';
import { checkBeforeModelSend, suspectedSecret } from '../../src/main/secret-check';

vi.mock('node:fs/promises', { spy: true });

let directory: string, root: string, inventory: Inventory, sources: Sources;
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
async function file(path: string, content: string | Buffer = 'needle\nsecond line\n') {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}
async function repository(path: string) { await mkdir(join(root, path), { recursive: true }); git(join(root, path), 'init'); }
const read = (path: string, start = 1, end = 40) => sources.run('read', { root, path, start, end });
beforeEach(async () => {
  vi.mocked(fs.open).mockImplementation((await vi.importActual<typeof fs>('node:fs/promises')).open).mockClear();
  directory = await realpath(await mkdtemp(join(tmpdir(), 'athena-sources-')));
  root = join(directory, 'chosen'); await mkdir(root);
  inventory = new Inventory(join(directory, 'inventory.sqlite'));
  await inventory.designate(root, FOLDER_CONSENT);
  sources = new Sources(join(directory, 'sources.sqlite'), inventory);
});
afterEach(async () => { vi.restoreAllMocks(); sources.close(); inventory.close(); await rm(directory, { recursive: true, force: true }); });

test('lists and searches non-Git heterogeneous text and cites bounded UTF-8 ranges without repository requirements', async () => {
  for (const path of ['notes.md', 'guide.txt', 'config.json', 'settings.yaml', 'src/main.ts', 'README']) await file(path);
  const listed = await sources.run('list', { root, path: '.' });
  expect(listed.status).toBe('complete');
  expect(listed.entries.filter(item => item.kind === 'file')).toHaveLength(6);
  const found = await sources.run('search', { root, path: '.', query: 'NEEDLE' });
  expect(found.status).toBe('complete');
  expect(found.entries.filter(entry => entry.text === 'needle')).toHaveLength(6);
  const excerpt = (await read('notes.md', 2, 2)).entries[0];
  expect(excerpt).toMatchObject({ text: 'second line', citation: { folder: root, path: 'notes.md', repository: null, revision: null, start: 2, end: 2, contentIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } });
  await file('notes.md', 'changed');
  expect((await read('notes.md')).entries[0].citation?.contentIdentity).not.toBe(excerpt.citation?.contentIdentity);
});

test('uses current tracked/untracked/dirty files, nearest live repository ownership, saved aliases, and checkout revisions', async () => {
  await repository('parent');
  await file('parent/source.ts', 'old committed code');
  git(join(root, 'parent'), 'add', '.');
  git(join(root, 'parent'), '-c', 'user.name=Fixture', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture');
  const head = git(join(root, 'parent'), 'rev-parse', 'HEAD');
  await inventory.scan();
  // Nested repo created after discovery must not be attributed to the parent.
  await repository('parent/nested'); await file('parent/nested/new.md');
  await file('parent/untracked.md'); await file('parent/source.ts', 'dirty checkout code');
  expect((await read('parent/source.ts')).entries[0]).toMatchObject({ text: 'dirty checkout code', citation: { revision: head, repository: { name: 'parent', path: 'parent' } } });
  expect((await read('parent/untracked.md')).entries[0].text).toContain('needle');
  expect((await read('parent/nested/new.md')).entries[0].citation?.repository?.path).toBe('parent/nested');
  expect(git(join(root, 'parent'), 'rev-parse', 'HEAD')).toBe(head);
  git(join(root, 'parent'), 'pack-refs', '--all');
  expect((await read('parent/source.ts')).entries[0].citation?.revision).toBe(head);
  await repository('other/parent'); await file('other/parent/readme.md');
  await inventory.scan(); inventory.register(join(root, 'other/parent'), 'secondary');
  expect((await read('other/parent/readme.md')).entries[0].citation?.repository?.name).toBe('secondary');
});

test('worktree/submodule metadata never follows an external gitdir, while contents retain separate ownership', async () => {
  await file('worktree/.git', `gitdir: ${directory}/outside\n`);
  await file('worktree/readme.md');
  const opened = vi.spyOn(fs, 'open');
  const entry = (await read('worktree/readme.md')).entries[0];
  expect(entry.citation).toMatchObject({ repository: { name: 'worktree', path: 'worktree' }, revision: null });
  expect(opened.mock.calls.some(([path]) => String(path).includes('/outside'))).toBe(false);
});

test('denies environment/credential files before any content open through list, search, reads, and exception attempts', async () => {
  for (const path of ['.env', '.env.local', '.env.production', '.npmrc', '.netrc', 'secrets.yaml', 'credentials.json', 'id_rsa', 'key.pem', '.aws/config', '.docker/config.json', '.git/objects/value']) await file(path, 'needle actual sensitive content');
  const opened = vi.spyOn(fs, 'open');
  for (const path of ['.env', '.env.local', '.env.production', '.npmrc', '.netrc', 'secrets.yaml', 'credentials.json', 'id_rsa', 'key.pem', '.aws/config', '.docker/config.json', '.git/objects/value']) {
    expect((await read(path)).entries[0].reason).toContain('protected');
    await expect(sources.exception(root, path, true)).rejects.toThrow();
  }
  expect(opened).not.toHaveBeenCalled();
  const search = await sources.run('search', { root, path: '.', query: 'needle' });
  expect(search.entries.some(entry => entry.text)).toBe(false);
  expect(JSON.stringify(search)).not.toContain('actual sensitive content');
});

test('unapproved roots are rejected before opening content or metadata', async () => {
  const opened = vi.spyOn(fs, 'open');
  await expect(sources.run('read', { root: directory, path: 'outside.md' })).rejects.toThrow('Folder permission');
  expect(opened).not.toHaveBeenCalled();
});

test('recognizable environment examples are eligible, but examples and ordinary files still undergo full-file secret checks', async () => {
  for (const path of ['.env.example', '.env.local.template', '.env.production.sample']) await file(path, 'API_KEY=your-key\nPORT=3000');
  for (const path of ['.env.example', '.env.local.template', '.env.production.sample']) expect((await read(path)).entries[0].text).toContain('PORT=3000');
  await file('.env.example', 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz');
  await file('notes.md', 'harmless first line\npassword: "sensitive-value"');
  for (const path of ['.env.example', 'notes.md']) {
    const result = await read(path, 1, 1);
    expect(result.entries[0].reason).toContain('Suspected secret');
    expect(JSON.stringify(result)).not.toContain('sensitive-value');
    await sources.exception(root, path, true);
    expect((await read(path)).entries[0].text).toBeUndefined();
  }
  const search = await sources.run('search', { root, path: '.', query: 'harmless' });
  expect(search.entries.some(entry => entry.text?.includes('harmless'))).toBe(false);
});

test('rejects traversal, absolute paths, file/directory symlinks, symlinked roots, and secret ancestor bypasses', async () => {
  await file('inside.md');
  await writeFile(join(directory, 'outside.md'), 'outside marker');
  await symlink(directory, join(root, 'escape'));
  await symlink(join(directory, 'outside.md'), join(root, 'linked.md'));
  for (const path of ['../outside.md', '/etc/passwd', 'escape/outside.md', 'linked.md', 'a/../inside.md', 'a\\b']) {
    const result = await read(path).catch(() => null);
    expect(result?.entries.some(entry => entry.text)).not.toBe(true);
    await expect(sources.exception(root, path, true)).rejects.toThrow();
  }
  await file('.env/nested.md');
  await expect(sources.exception(root, '.env/nested.md', true)).rejects.toThrow();
  await rename(root, join(directory, 'old-root')); await symlink(directory, root);
  expect((await read('outside.md')).entries[0].text).toBeUndefined();
});

test('rechecks a parent swapped to an escaping symlink between validation and open, before content reads', async () => {
  await file('safe/note.md', 'inside');
  await mkdir(join(directory, 'outside'));
  await writeFile(join(directory, 'outside', 'note.md'), 'outside secret marker');
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  const opened = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === join(root, 'safe/note.md')) {
      await rename(join(root, 'safe'), join(root, 'old-safe'));
      await symlink(join(directory, 'outside'), join(root, 'safe'));
    }
    const fd = await original(...args);
    vi.spyOn(fd, 'read');
    return fd;
  });
  const result = await read('safe/note.md');
  expect(result.entries[0].text).toBeUndefined();
  for (const call of opened.mock.results) {
    if (call.type === 'return') expect((await call.value).read).not.toHaveBeenCalled();
  }
});

test('default exclusions and nested Git ignore/negation rules apply to direct reads and search; safe exceptions persist', async () => {
  await repository('repo');
  await file('repo/.gitignore', '*.log\nignored/\n*.txt\n!keep.txt\n');
  await file('repo/.git/info/exclude', 'private.md\n');
  for (const path of ['repo/run.log', 'repo/ignored/note.md', 'repo/private.md', 'repo/skip.txt', 'repo/keep.txt', 'repo/sub/keep.txt', 'repo/sub/other.md', 'vendor/dep.ts', 'dist/out.js', '.hidden/doc.md', 'bundle.min.js']) await file(path);
  await file('repo/sub/.gitignore', '!keep.txt\nother.md\n');
  for (const path of ['repo/run.log', 'repo/ignored/note.md', 'repo/private.md', 'repo/skip.txt', 'repo/sub/other.md', 'vendor/dep.ts', 'dist/out.js', '.hidden/doc.md', 'bundle.min.js']) expect((await read(path)).entries[0].overridable).toBe(true);
  expect((await read('repo/keep.txt')).entries[0].text).toContain('needle');
  expect((await read('repo/sub/keep.txt')).entries[0].text).toContain('needle');
  const found = await sources.run('search', { root, path: '.', query: 'needle' });
  expect(found.entries.filter(entry => entry.text).map(entry => entry.path).sort()).toEqual(['repo/keep.txt', 'repo/sub/keep.txt']);
  await sources.exception(root, 'repo/ignored', true);
  await sources.exception(root, 'vendor', true);
  sources.close(); sources = new Sources(join(directory, 'sources.sqlite'), inventory);
  expect((await read('repo/ignored/note.md')).entries[0].text).toContain('needle');
  expect((await read('vendor/dep.ts')).entries[0].text).toContain('needle');
  await sources.exception(root, 'vendor', false);
  expect((await read('vendor/dep.ts')).entries[0].text).toBeUndefined();
  await file('vendor/sibling.ts');
  await sources.exception(root, 'vendor/dep.ts', true);
  expect((await read('vendor/dep.ts')).entries[0].text).toContain('needle');
  expect((await read('vendor/sibling.ts')).entries[0].text).toBeUndefined();
  const narrow = await sources.run('search', { root, path: 'vendor', query: 'needle' });
  expect(narrow.entries.filter(entry => entry.text).map(entry => entry.path)).toEqual(['vendor/dep.ts']);
});

test('detects binary/encoding/generated inputs and enforces line, per-file, input-byte, output and result bounds', async () => {
  await file('binary.dat', Buffer.from([0, 1, 2]));
  await file('invalid.txt', Buffer.from([0xff, 0xfe]));
  await file('manual.pdf', 'text is not PDF interpretation');
  await file('generated.ts', '// @generated do not edit\nneedle');
  await file('large.txt', 'x'.repeat(L.fileBytes + 1));
  for (const path of ['binary.dat', 'invalid.txt', 'manual.pdf', 'generated.ts', 'large.txt']) expect((await read(path)).entries[0].reason).toBeTruthy();
  await expect(read('large.txt', 1, 201)).rejects.toThrow();
  await file('long-line.txt', 'x'.repeat(20 * 1024));
  expect((await read('long-line.txt')).entries[0].reason).toContain('output-byte');
  for (let index = 0; index < 205; index++) await file(`many/${index}.md`);
  const found = await sources.run('search', { root, path: 'many', query: 'needle' });
  expect(found.status).toBe('truncated'); expect(found.entries.length).toBe(L.results);
  expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThan(L.outputBytes + 1024);
  for (let index = 0; index < 10; index++) await file(`bytes/${index}.txt`, 'x'.repeat(240 * 1024));
  const bytes = await sources.run('search', { root, path: 'bytes', query: 'absent' });
  expect(bytes.status).toBe('truncated'); expect(bytes.reason).toContain('Input-byte'); expect(bytes.bytesRead).toBeLessThanOrEqual(L.totalBytes);
});

test('cancellation, time and entry/depth limits produce explicit partial results and stop further reads', async () => {
  await file('notes.md');
  const controller = new AbortController(); controller.abort();
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  const opened = vi.spyOn(fs, 'open');
  expect((await sources.run('read', { root, path: 'notes.md' }, controller.signal)).status).toBe('cancelled');
  expect(opened).not.toHaveBeenCalled();
  const active = new AbortController();
  opened.mockImplementation(async (...args) => { active.abort(); return original(...args); });
  expect((await sources.run('read', { root, path: 'notes.md' }, active.signal)).status).toBe('cancelled');
  opened.mockRestore();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => { now += 2000; return now; });
  expect((await sources.run('list', { root, path: '.' })).reason).toContain('Time limit');
});

test('entry and depth bounds report unexamined material explicitly', async () => {
  await Promise.all(Array.from({ length: L.entries + 1 }, (_, index) => file(`count/${index}.txt`, 'ordinary')));
  const count = await sources.run('search', { root, path: 'count', query: 'absent' });
  expect(count.status).toBe('truncated'); expect(count.reason).toContain('Entry limit');
  await file(`${Array.from({ length: L.depth + 1 }, () => 'deep').join('/')}/note.txt`);
  const depth = await sources.run('search', { root, path: 'deep', query: 'absent' });
  expect(depth.status).toBe('truncated'); expect(depth.reason).toContain('depth');
}, 15000);

test('cancellation returns even while an OS open is pending, and late completion never reads content', async () => {
  await file('notes.md');
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  const controller = new AbortController();
  let release!: () => void;
  let reached!: () => void;
  const atOpen = new Promise<void>(resolve => { reached = resolve; });
  const fd = await original(join(root, 'notes.md'), 'r');
  const reads = vi.spyOn(fd, 'read');
  const closes = vi.spyOn(fd, 'close');
  vi.spyOn(fs, 'open').mockImplementation(async () => {
    reached(); await new Promise<void>(resolve => { release = resolve; }); return fd;
  });
  const pending = sources.run('read', { root, path: 'notes.md' }, controller.signal);
  await atOpen; controller.abort();
  expect((await pending).status).toBe('cancelled');
  release();
  await expect.poll(() => closes.mock.calls.length).toBe(1);
  expect(reads).not.toHaveBeenCalled();
});

test('pre-send guard checks composed context and adapters expose only the same three bounded operations', async () => {
  expect(() => checkBeforeModelSend({ messages: [{ content: 'token=real-sensitive-value' }] })).toThrow('suspected secret');
  expect(() => checkBeforeModelSend({ max_tokens: 64, messages: [{ content: 'ordinary evidence' }] })).not.toThrow();
  for (const value of ['-----BEGIN RSA PRIVATE KEY-----', 'AKIA1234567890123456', 'https://user:password@example.com']) expect(suspectedSecret(value)).toBe(true);
  await file('notes.md'); await file('.env', 'needle');
  const tools = sourceTools(sources);
  expect(tools.map(tool => tool.name)).toEqual(['sources_list', 'sources_search', 'sources_read']);
  const result = await tools[2].execute('id', { root, path: 'notes.md', start: 1, end: 1 });
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(await read('notes.md', 1, 1)) }]);
  const denied = await tools[2].execute('id', { root, path: '.env' });
  expect(JSON.stringify(denied)).not.toContain('needle');
  const arbitrary = await tools[2].execute('id', { root, path: 'notes.md', shell: 'echo no' });
  expect(arbitrary.isError).toBe(true);
  await file('token=actual-sensitive-value.md', 'ordinary evidence');
  const metadataSecret = await tools[2].execute('id', { root, path: 'token=actual-sensitive-value.md' });
  expect(metadataSecret.isError).toBe(true);
  expect(JSON.stringify(metadataSecret)).not.toContain('actual-sensitive-value');
});
