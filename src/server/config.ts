import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ProxyMode } from '../shared/url.js';

export const APP_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, '../../../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface AppConfig {
  host: string;
  port: number;
  /** Origin that serves the browser UI, e.g. https://openaccess.example */
  publicOrigin: string | null;
  /** Optional separate origin that serves proxied content, e.g. https://p.openaccess.example */
  contentOrigin: string | null;
  trustProxy: boolean;
  /** Set when the directory listing / CDN in front of us rewrites the scheme. */
  forceHttps: boolean;
  accessLog: boolean;
  maxSessions: number;
  sessionIdleMs: number;
  sessionMaxMs: number;
  maxResponseBytes: number;
  maxUploadBytes: number;
  /** Maximum total size of an upstream response header block. */
  maxUpstreamHeaderBytes: number;
  upstreamConnectTimeoutMs: number;
  upstreamHeadersTimeoutMs: number;
  upstreamBodyTimeoutMs: number;
  maxRedirects: number;
  rateLimitWindowMs: number;
  maxRequestsPerIp: number;
  maxRequestsPerSession: number;
  maxSessionCreatesPerIp: number;
  sessionCreateWindowMs: number;
  maxConcurrentPerSession: number;
  enableWebSockets: boolean;
  maxWsMessageBytes: number;
  allowedPorts: number[] | null;
  blockedPorts: number[];
  blockedHosts: string[];
  blockedHostSuffixes: string[];
  egressLimitBytesPerHour: number;
  /** In-memory per-host storage for sites that rely on localStorage. */
  enableServerStorage: boolean;
  /** Allow access to loopback / private networks. Never enable on a public deployment. */
  allowPrivateTargets: boolean;
  maxStorageBytesPerHost: number;
  /** Process-wide ceiling for decoded HTML/CSS held in memory at once. */
  maxBufferedBytes: number;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function origin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const DEFAULT_BLOCKED_PORTS = [
  21, 22, 23, 25, 111, 135, 137, 138, 139, 445, 465, 512, 513, 514, 587, 993, 995,
  1433, 1521, 2049, 2181, 2375, 2376, 3306, 3389, 4369, 5432, 5672, 5900, 6379,
  6443, 7001, 8009, 9000, 9042, 9200, 9300, 11211, 15672, 27017, 27018, 28017,
  50070, 61616, 10250, 10255,
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.HOST || '0.0.0.0',
    port: num(env.PORT, 3000),
    // Render injects RENDER_EXTERNAL_URL for web services. Using it as a
    // fallback gives a zero-config deploy the correct canonical origin and
    // keeps the strict host gate working before a custom domain is attached.
    publicOrigin: origin(env.PUBLIC_ORIGIN) ?? origin(env.RENDER_EXTERNAL_URL),
    contentOrigin: origin(env.CONTENT_ORIGIN),
    trustProxy: bool(env.TRUST_PROXY, true),
    forceHttps: bool(env.FORCE_HTTPS, false),
    accessLog: bool(env.ACCESS_LOG, false),
    maxSessions: num(env.MAX_SESSIONS, 2000),
    sessionIdleMs: num(env.SESSION_IDLE_MINUTES, 120) * 60_000,
    sessionMaxMs: num(env.SESSION_MAX_HOURS, 12) * 3_600_000,
    maxResponseBytes: num(env.MAX_RESPONSE_MB, 30) * 1024 * 1024,
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 10) * 1024 * 1024,
    // undici defaults to 16 KiB, which YouTube and some cookie-heavy sites
    // exceed. 128 KiB covers real responses without letting one connection
    // reserve an unbounded buffer.
    maxUpstreamHeaderBytes:
      Math.max(16, Math.min(512, num(env.MAX_UPSTREAM_HEADER_KB, 128))) * 1024,
    upstreamConnectTimeoutMs: num(env.UPSTREAM_CONNECT_TIMEOUT_MS, 10_000),
    upstreamHeadersTimeoutMs: num(env.UPSTREAM_HEADERS_TIMEOUT_MS, 20_000),
    upstreamBodyTimeoutMs: num(env.UPSTREAM_BODY_TIMEOUT_MS, 120_000),
    maxRedirects: num(env.MAX_REDIRECTS, 8),
    rateLimitWindowMs: num(env.RATE_LIMIT_WINDOW_SECONDS, 60) * 1000,
    maxRequestsPerIp: num(env.RATE_LIMIT_PER_IP, 2400),
    maxRequestsPerSession: num(env.RATE_LIMIT_PER_SESSION, 1200),
    maxSessionCreatesPerIp: num(env.SESSION_CREATES_PER_HOUR, 60),
    sessionCreateWindowMs: num(env.SESSION_CREATE_WINDOW_MINUTES, 60) * 60_000,
    maxConcurrentPerSession: num(env.MAX_CONCURRENT_REQUESTS_PER_SESSION, 12),
    enableWebSockets: bool(env.ENABLE_WEBSOCKETS, true),
    maxWsMessageBytes: num(env.MAX_WS_MESSAGE_KB, 512) * 1024,
    allowedPorts: env.ALLOWED_UPSTREAM_PORTS
      ? env.ALLOWED_UPSTREAM_PORTS.split(',')
          .map((p) => Number.parseInt(p, 10))
          .filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
      : null,
    blockedPorts: env.BLOCKED_UPSTREAM_PORTS
      ? env.BLOCKED_UPSTREAM_PORTS.split(',')
          .map((p) => Number.parseInt(p, 10))
          .filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
      : DEFAULT_BLOCKED_PORTS,
    blockedHosts: list(env.BLOCKED_HOSTS),
    blockedHostSuffixes: list(env.BLOCKED_HOST_SUFFIXES),
    egressLimitBytesPerHour: num(env.EGRESS_LIMIT_MB_PER_HOUR, 0) * 1024 * 1024,
    enableServerStorage: bool(env.ENABLE_SERVER_STORAGE, true),
    allowPrivateTargets: bool(env.ALLOW_PRIVATE_TARGETS, false),
    maxStorageBytesPerHost: num(env.MAX_STORAGE_KB_PER_HOST, 512) * 1024,
    maxBufferedBytes: num(env.MAX_BUFFERED_MB, 128) === 0 ? Number.POSITIVE_INFINITY : num(env.MAX_BUFFERED_MB, 128) * 1024 * 1024,
  };
}

export interface RequestOrigins {
  publicOrigin: string;
  contentOrigin: string;
  mode: ProxyMode;
}

/** Resolve the origins this request arrived on, taking reverse proxies into account. */
export function resolveOrigins(config: AppConfig, headers: Record<string, string | string[] | undefined>): RequestOrigins {
  // Codespaces and other reverse proxies may rewrite Host and pass the
  // original hostname in X-Forwarded-Host. Only honour it when the deployment
  // has opted into trusting proxy headers.
  const forwardedHost =
    config.trustProxy && header(headers, 'x-forwarded-host')
      ? header(headers, 'x-forwarded-host')!.split(',')[0]!.trim()
      : undefined;
  const host = forwardedHost || header(headers, 'host') || `localhost:${config.port}`;
  const forwardedProto = header(headers, 'x-forwarded-proto');
  const proto = config.forceHttps ? 'https' : forwardedProto?.split(',')[0]?.trim() || 'http';
  const requestOrigin = `${proto}://${host}`;

  const publicOrigin = config.publicOrigin ?? requestOrigin;
  const contentOrigin = config.contentOrigin ?? publicOrigin;

  return {
    publicOrigin,
    contentOrigin,
    mode: new URL(contentOrigin).host === new URL(publicOrigin).host ? 'shared' : 'isolated',
  };
}

export function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
