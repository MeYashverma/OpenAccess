import { buildApp } from './app.js';
import { loadConfig, APP_VERSION } from './config.js';
import { createDeps } from './deps.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = createDeps(config);
  const app = buildApp(deps);

  const production = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    process.stderr.write(`[openaccess] failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  }

  const banner = [
    '',
    `  OpenAccess ${APP_VERSION}`,
    `  listening on http://${config.host}:${config.port}`,
    `  public origin:  ${config.publicOrigin ?? '(derived from request)'}`,
    `  content origin: ${config.contentOrigin ?? '(same origin — sandboxed, reduced site compatibility)'}`,
    '',
  ].join('\n');
  process.stdout.write(`${banner}\n`);

  if (production && config.contentOrigin) {
    process.stderr.write(
      '[openaccess] warning: CONTENT_ORIGIN is set. All proxied destinations share one real origin, so a ' +
        'malicious proxied page can read other proxied pages in the same session. Use shared mode (unset ' +
        'CONTENT_ORIGIN) for untrusted public browsing. See docs/SECURITY.md.\n',
    );
  }
  if (production && config.publicOrigin?.startsWith('http://')) {
    process.stderr.write('[openaccess] warning: PUBLIC_ORIGIN is not HTTPS.\n');
  }

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`[openaccess] ${signal} received, closing\n`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
