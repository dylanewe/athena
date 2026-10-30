import { build as bundle } from 'esbuild';
import { build as vite } from 'vite';
import { rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await bundle({
  entryPoints: { main: 'src/main/index.ts', worker: 'src/worker/demo.ts', connection: 'src/worker/connection.ts', chatgpt: 'src/worker/chatgpt.ts', live: 'src/worker/live.ts' },
  outdir: 'dist', bundle: true, platform: 'node', format: 'esm',
  packages: 'external', target: 'node24',
});
await bundle({
  entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24',
});
await vite();
