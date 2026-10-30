import { spawn } from 'node:child_process';
import { ApiSettingsError } from './pi-model-config';

export type CredentialHelper = (command: string, signal: AbortSignal) => Promise<string>;
/** Trusted user configuration only, never exposed as an agent tool. No project cwd or shell rc. */
export function runCredentialHelper(cwd: string, env: NodeJS.ProcessEnv): CredentialHelper {
  return (command, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ApiSettingsError('Credential resolution cancelled.')); return; }
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...env, ENV: '', BASH_ENV: '' }, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
      if (value?.trim()) resolve(value.trim());
      else reject(new ApiSettingsError(signal.aborted ? 'Credential resolution cancelled.' : 'Credential helper failed, timed out, or returned empty/oversized output. No request sent.'));
    };
    const abort = () => finish();
    const timer = setTimeout(() => finish(), 10_000);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (Buffer.byteLength(output) > 8192) finish(); });
    child.on('error', () => finish());
    child.on('close', code => finish(code === 0 ? output : undefined));
  });
}
/** Pi 1.4 templates: $VAR, ${VAR}, $$ → $, $! → !. Bare names are literals. */
export function interpolateCredential(value: string, env: NodeJS.ProcessEnv): string {
  let missing = false;
  const result = value.replace(/\$(\$|!|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/gu, (_match, name: string) => {
    if (name === '$' || name === '!') return name;
    const resolved = env[name.startsWith('{') ? name.slice(1, -1) : name];
    if (!resolved) missing = true;
    return resolved ?? '';
  });
  if (missing || !result) throw new ApiSettingsError('A credential environment reference is unset or empty. Set it before launching Athena; repository environment files are never read.');
  return result;
}
