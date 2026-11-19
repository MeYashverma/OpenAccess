import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent as HttpsAgent } from 'node:https';
import { Agent as HttpAgent } from 'node:http';
import { Agent } from 'undici';
import type { AppConfig } from './config.js';

/**
 * SSRF protection.
 *
 * Every outbound connection made by the proxy goes through one of two gates:
 *
 *  1. `assertSafeTarget` — validates scheme, credentials, port, hostname rules
 *     and every DNS answer before a request is created.
 *  2. A custom `lookup` function installed in the HTTP agents — re-validates
 *     the address the socket is *actually* about to connect to. This closes the
 *     DNS-rebinding window where a name points at a public address during
 *     validation and at 127.0.0.1 (or 169.254.169.254) milliseconds later.
 *
 * IP literals are validated without DNS. IPv4-mapped IPv6, NAT64 and 6to4
 * addresses are unwrapped so that `::ffff:127.0.0.1` cannot slip through.
 */

export type TargetErrorCode =
  | 'blocked-scheme'
  | 'blocked-credentials'
  | 'blocked-host'
  | 'blocked-port'
  | 'blocked-address'
  | 'invalid-url'
  | 'dns-failed';

export class TargetError extends Error {
  constructor(
    readonly code: TargetErrorCode,
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = 'TargetError';
  }
}

const IPV4_BLOCKED_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  for (const [base, bits] of IPV4_BLOCKED_RANGES) {
    const baseValue = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return true;
  }
  return false;
}

function expandIpv6(ip: string): number[] | null {
  let address = ip;
  if (address.includes('%')) address = address.slice(0, address.indexOf('%')); // zone id

  // A trailing dotted-quad (IPv4-mapped / compatible / NAT64) is converted to
  // two hextets first.
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const high = (v4 >>> 16).toString(16);
    const low = (v4 & 0xffff).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const [head, rest] = address.split('::');
  if (address.includes('::') && rest === undefined) return null;
  const headParts = head ? head.split(':') : [];
  const restParts = rest !== undefined ? (rest ? rest.split(':') : []) : [];
  if (rest !== undefined && address.split('::').length > 2) return null;
  const missing = 8 - headParts.length - restParts.length;
  if (missing < 0) return null;
  if (rest === undefined && headParts.length !== 8) return null;

  const hextets = [...headParts, ...new Array(missing).fill('0'), ...restParts];
  if (hextets.length !== 8) return null;

  const groups: number[] = [];
  for (const hextet of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(hextet)) return null;
    groups.push(Number.parseInt(hextet, 16));
  }
  return groups;
}

function hasIpv6Prefix(groups: number[], prefix: number[], bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < prefix.length && remaining > 0; i++) {
    const compare = Math.min(16, remaining);
    const mask = compare === 16 ? 0xffff : (0xffff << (16 - compare)) & 0xffff;
    if ((groups[i]! & mask) !== (prefix[i]! & mask)) return false;
    remaining -= compare;
  }
  return true;
}

function embeddedIpv4(groups: number[]): string {
  return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
}

export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version !== 6) return true;

  const groups = expandIpv6(ip);
  if (!groups) return true;

  // Unspecified / loopback.
  if (groups.every((g) => g === 0)) return true;
  if (hasIpv6Prefix(groups, [0, 0, 0, 0, 0, 0, 0, 1], 128)) return true;

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible: judge by the embedded v4.
  if (hasIpv6Prefix(groups, [0, 0, 0, 0, 0, 0xffff, 0, 0], 96)) return isBlockedIpv4(embeddedIpv4(groups));
  if (hasIpv6Prefix(groups, [0, 0, 0, 0, 0, 0, 0, 0], 96)) return true;

  // NAT64 64:ff9b::/96 — unwrap the embedded IPv4.
  if (hasIpv6Prefix(groups, [0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96)) return isBlockedIpv4(embeddedIpv4(groups));
  // 6to4 2002::/16 — embedded IPv4 in hextets 1-2.
  if (hasIpv6Prefix(groups, [0x2002, 0, 0, 0, 0, 0, 0, 0], 16)) {
    const v4 = `${groups[1]! >> 8}.${groups[1]! & 0xff}.${groups[2]! >> 8}.${groups[2]! & 0xff}`;
    return isBlockedIpv4(v4);
  }
  // Teredo 2001::/32
  if (hasIpv6Prefix(groups, [0x2001, 0, 0, 0, 0, 0, 0, 0], 32)) return true;

  // Unique local fc00::/7, link local fe80::/10, multicast ff00::/8,
  // documentation 2001:db8::/32, discard 100::/64.
  if (hasIpv6Prefix(groups, [0xfc00, 0, 0, 0, 0, 0, 0, 0], 7)) return true;
  if (hasIpv6Prefix(groups, [0xfe80, 0, 0, 0, 0, 0, 0, 0], 10)) return true;
  if (hasIpv6Prefix(groups, [0xff00, 0, 0, 0, 0, 0, 0, 0], 8)) return true;
  if (hasIpv6Prefix(groups, [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32)) return true;
  if (hasIpv6Prefix(groups, [0x0100, 0, 0, 0, 0, 0, 0, 0], 64)) return true;

  return false;
}

/** Hostname without IPv6 brackets or a trailing dot. */
export function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** Check a target without touching the network. */
export function assertSafeUrlShape(url: URL, config: AppConfig, selfHosts: Set<string> = new Set()): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetError('blocked-scheme', 'Only http and https addresses can be opened through OpenAccess.');
  }
  if (url.username || url.password) {
    throw new TargetError('blocked-credentials', 'Addresses that embed credentials are not supported.');
  }
  const hostname = normalizedHostname(url);
  if (!hostname) throw new TargetError('invalid-url', 'The address has no hostname.');

  const port = effectivePort(url);
  if (config.blockedPorts.includes(port)) {
    throw new TargetError('blocked-port', `Port ${port} is not allowed through the proxy.`);
  }
  if (config.allowedPorts && !config.allowedPorts.includes(port)) {
    throw new TargetError('blocked-port', `Port ${port} is not in the allowed port list.`);
  }
  if (!config.allowedPorts && port < 1024 && port !== 80 && port !== 443) {
    throw new TargetError('blocked-port', `Port ${port} is reserved for system services and is not proxied.`);
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
      hostname.endsWith('.internal') || hostname.endsWith('.lan') || hostname.endsWith('.home.arpa') ||
      hostname === 'metadata.google.internal' || hostname === 'instance-data') {
    throw new TargetError('blocked-host', 'That address points at a private or local network.');
  }
  for (const blocked of config.blockedHosts) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      throw new TargetError('blocked-host', 'That destination is blocked by this deployment.');
    }
  }
  for (const suffix of config.blockedHostSuffixes) {
    if (hostname === suffix || hostname.endsWith(suffix)) {
      throw new TargetError('blocked-host', 'That destination is blocked by this deployment.');
    }
  }
  // Refuse to proxy the proxy's own listener (loop protection). Comparing
  // host:port keeps local/self-hosted deployments able to reach other services
  // on the same machine, which is useful for development and intranets.
  if (selfHosts.has(`${hostname}:${port}`)) {
    throw new TargetError('blocked-host', 'OpenAccess will not proxy itself.');
  }

  if (!config.allowPrivateTargets && isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      throw new TargetError('blocked-address', 'That address points at a private, local or reserved network.');
    }
  }
}

const dnsCache = new Map<string, { addresses: LookupAddress[]; expires: number }>();
const DNS_CACHE_MS = 30_000;

async function resolveHost(hostname: string): Promise<LookupAddress[]> {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.addresses;

  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, list) => {
      if (error) reject(error);
      else resolve(list as LookupAddress[]);
    });
  });

  if (dnsCache.size > 5000) dnsCache.clear();
  dnsCache.set(hostname, { addresses, expires: Date.now() + DNS_CACHE_MS });
  return addresses;
}

/** Full validation including DNS. */
export async function assertSafeTarget(url: URL, config: AppConfig, selfHosts: Set<string> = new Set()): Promise<void> {
  assertSafeUrlShape(url, config, selfHosts);
  if (config.allowPrivateTargets) return;

  const hostname = normalizedHostname(url);
  if (isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      throw new TargetError('blocked-address', 'That address points at a private, local or reserved network.');
    }
    return;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new TargetError('dns-failed', `Could not resolve ${hostname}.`);
  }
  if (addresses.length === 0) {
    throw new TargetError('dns-failed', `Could not resolve ${hostname}.`);
  }
  for (const address of addresses) {
    if (isBlockedIp(address.address)) {
      throw new TargetError('blocked-address', `The hostname ${hostname} resolves to a private or reserved address.`);
    }
  }
}

/**
 * net.LookupFunction installed in every outbound agent. Validates the exact
 * addresses the socket will connect to, right before connecting.
 */
export function makeGuardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const list = addresses as LookupAddress[];
      if (list.length === 0) {
        callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
        return;
      }
      if (!allowPrivate) {
        const blocked = list.find((entry) => isBlockedIp(entry.address));
        if (blocked) {
          callback(
            Object.assign(new Error('Target resolved to a non-public address'), { code: 'EBLOCKEDTARGET' }),
            '',
            0,
          );
          return;
        }
      }
      if (options.all) {
        (callback as unknown as (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void)(null, list);
        return;
      }
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export function createUpstreamDispatcher(config: AppConfig) {
  return new Agent({
    connect: {
      lookup: makeGuardedLookup(config.allowPrivateTargets),
      timeout: config.upstreamConnectTimeoutMs,
    },
    headersTimeout: config.upstreamHeadersTimeoutMs,
    bodyTimeout: config.upstreamBodyTimeoutMs,
    keepAliveTimeout: 15_000,
    keepAliveMaxTimeout: 30_000,
  });
}

export function createWsAgents(config: AppConfig) {
  const lookup = makeGuardedLookup(config.allowPrivateTargets);
  return {
    http: new HttpAgent({ lookup, keepAlive: true, timeout: config.upstreamConnectTimeoutMs }),
    https: new HttpsAgent({ lookup, keepAlive: true, timeout: config.upstreamConnectTimeoutMs }),
  };
}
