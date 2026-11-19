import { randomBytes } from 'node:crypto';
import { CookieJar } from './cookies.js';
import type { AppConfig } from './config.js';

export interface Session {
  token: string;
  createdAt: number;
  lastSeen: number;
  createdFrom: string;
  jar: CookieJar;
  /** localStorage-style key/value buckets, keyed by target hostname. */
  storage: Map<string, Map<string, string>>;
  storageBytes: number;
  inflight: number;
  requests: number;
  bytesOut: number;
}

export type SessionCreateResult =
  | { ok: true; session: Session }
  | { ok: false; reason: 'capacity' };

/**
 * In-memory session store.
 *
 * Sessions hold the server-side cookie jar for a browsing session. They are
 * deliberately ephemeral: a restart logs everybody out of proxied sites. For a
 * horizontally scaled deployment, swap this for a shared store with sticky
 * routing; the public deployment target documented in docs/DEPLOYMENT.md runs a
 * single instance.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout;

  constructor(private readonly config: AppConfig) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  create(ip: string): SessionCreateResult {
    this.sweep();
    if (this.sessions.size >= this.config.maxSessions) {
      // Evict the least recently used session rather than refusing every new
      // visitor once the cap is reached.
      let oldest: Session | null = null;
      for (const session of this.sessions.values()) {
        if (!oldest || session.lastSeen < oldest.lastSeen) oldest = session;
      }
      if (oldest) this.sessions.delete(oldest.token);
      if (this.sessions.size >= this.config.maxSessions) return { ok: false, reason: 'capacity' };
    }

    let token = randomBytes(24).toString('base64url');
    while (this.sessions.has(token)) token = randomBytes(24).toString('base64url');

    const now = Date.now();
    const session: Session = {
      token,
      createdAt: now,
      lastSeen: now,
      createdFrom: ip,
      jar: new CookieJar(),
      storage: new Map(),
      storageBytes: 0,
      inflight: 0,
      requests: 0,
      bytesOut: 0,
    };
    this.sessions.set(token, session);
    return { ok: true, session };
  }

  get(token: string, touch = true): Session | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (this.isExpired(session)) {
      this.sessions.delete(token);
      return null;
    }
    if (touch) session.lastSeen = Date.now();
    return session;
  }

  destroy(token: string): boolean {
    return this.sessions.delete(token);
  }

  private isExpired(session: Session): boolean {
    const now = Date.now();
    return now - session.lastSeen > this.config.sessionIdleMs || now - session.createdAt > this.config.sessionMaxMs;
  }

  sweep(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (this.isExpired(session)) this.sessions.delete(token);
      if (now - session.lastSeen > 24 * 60 * 60 * 1000) this.sessions.delete(token);
    }
  }

  get count(): number {
    return this.sessions.size;
  }

  stats(): { sessions: number; inflight: number } {
    let inflight = 0;
    for (const session of this.sessions.values()) inflight += session.inflight;
    return { sessions: this.sessions.size, inflight };
  }

  close(): void {
    clearInterval(this.sweeper);
    this.sessions.clear();
  }
}

/** Simple bounded key/value storage used as a localStorage fallback. */
export class SessionStorage {
  constructor(private readonly maxBytesPerHost: number) {}

  get(session: Session, host: string, key: string): string | null {
    return session.storage.get(host)?.get(key) ?? null;
  }

  set(session: Session, host: string, key: string, value: string): boolean {
    const bucket = session.storage.get(host) ?? new Map<string, string>();
    const previous = bucket.get(key);
    const delta = Buffer.byteLength(key) + Buffer.byteLength(value) - (previous ? Buffer.byteLength(key) + Buffer.byteLength(previous) : 0);
    if (session.storageBytes + delta > this.maxBytesPerHost * 20 || delta > this.maxBytesPerHost) return false;
    bucket.set(key, value);
    session.storage.set(host, bucket);
    session.storageBytes += delta;
    return true;
  }

  delete(session: Session, host: string, key: string): void {
    const bucket = session.storage.get(host);
    if (!bucket) return;
    const value = bucket.get(key);
    if (value !== undefined) {
      session.storageBytes -= Buffer.byteLength(key) + Buffer.byteLength(value);
      bucket.delete(key);
    }
  }

  clearHost(session: Session, host: string): void {
    const bucket = session.storage.get(host);
    if (!bucket) return;
    for (const [key, value] of bucket) {
      session.storageBytes -= Buffer.byteLength(key) + Buffer.byteLength(value);
    }
    session.storage.delete(host);
  }

  dump(session: Session, host: string): Record<string, string> {
    return Object.fromEntries(session.storage.get(host) ?? []);
  }
}
