/* Development runner: builds the browser runtime + client once, then runs the
   TypeScript server with `tsx --watch`. Rebuilding the client after UI edits:
   run `npm run build:client` in a second terminal. */
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });

const buildClient = run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.client.config.ts']);
buildClient.on('exit', async (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const runtime = run(process.execPath, ['scripts/build-runtime.mjs']);
  runtime.on('exit', (rcode) => {
    if (rcode !== 0) process.exit(rcode ?? 1);
    const server = run(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'src/server/index.ts']);
    server.on('exit', (scode) => process.exit(scode ?? 0));
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
  });
});
