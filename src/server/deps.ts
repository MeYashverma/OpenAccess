import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent as HttpAgent } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import type { Dispatcher } from 'undici';
import { loadConfig, type AppConfig } from './config.js';
import { HourlyBudget, FixedWindowLimiter } from './rate-limit.js';
import { SessionStorage, SessionStore } from './sessions.js';
import { createUpstreamDispatcher, createWsAgents } from './ssrf.js';

export interface RuntimeAsset {
  source: string;
  etag: string;
}

export interface AppDeps {
  config: AppConfig;
  sessions: SessionStore;
  storage: SessionStorage;
  ipLimiter: FixedWindowLimiter;
  sessionLimiter: FixedWindowLimiter;
  sessionCreateLimiter: FixedWindowLimiter;
  budget: HourlyBudget;
  dispatcher: Dispatcher;
  secret: Buffer;
  wsAgents: { http: HttpAgent; https: HttpsAgent };
  runtime: RuntimeAsset;
  startedAt: number;
  /** Bytes of decoded HTML/CSS currently held for rewriting. */
  buffer: { bytes: number };
}

function locateRuntime(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../runtime/runtime.js'), // dist/server/server -> dist/runtime? see below
    resolve(here, '../../runtime/runtime.js'),
    resolve(process.cwd(), 'dist/runtime/runtime.js'),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'The page runtime (dist/runtime/runtime.js) is missing. Run `npm run build:runtime` before starting the server.',
  );
}

export function createDeps(config: AppConfig = loadConfig()): AppDeps {
  const source = locateRuntime();
  return {
    config,
    sessions: new SessionStore(config),
    storage: new SessionStorage(config.maxStorageBytesPerHost),
    ipLimiter: new FixedWindowLimiter(config.maxRequestsPerIp, config.rateLimitWindowMs),
    sessionLimiter: new FixedWindowLimiter(config.maxRequestsPerSession, config.rateLimitWindowMs),
    sessionCreateLimiter: new FixedWindowLimiter(
      config.maxSessionCreatesPerIp,
      config.sessionCreateWindowMs,
    ),
    budget: new HourlyBudget(config.egressLimitBytesPerHour),
    dispatcher: createUpstreamDispatcher(config),
    secret: randomBytes(32),
    wsAgents: createWsAgents(config),
    runtime: {
      source,
      etag: `"oa-${Buffer.from(source).length.toString(16)}"`,
    },
    startedAt: Date.now(),
    buffer: { bytes: 0 },
  };
}

export function closeDeps(deps: AppDeps): void {
  deps.sessions.close();
  deps.ipLimiter.close();
  deps.sessionLimiter.close();
  deps.sessionCreateLimiter.close();
  deps.budget.close();
  void deps.dispatcher.close();
  deps.wsAgents.http.destroy();
  deps.wsAgents.https.destroy();
}
