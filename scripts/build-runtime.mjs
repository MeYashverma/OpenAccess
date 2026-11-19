import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync(new URL('../dist/runtime/', import.meta.url), { recursive: true });

await build({
  entryPoints: [new URL('../src/runtime/index.ts', import.meta.url).pathname],
  outfile: new URL('../dist/runtime/runtime.js', import.meta.url).pathname,
  bundle: true,
  format: 'iife',
  target: ['chrome100', 'firefox100', 'safari15'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});
