import { createHmac } from 'node:crypto';

/**
 * A document handle binds a runtime request to (session, target host).
 *
 * The runtime sends it with storage and cookie writes. Because it is signed and
 * includes the host, a page on site A cannot read or write the storage bucket
 * or cookies of site B in the same browsing session — even though both pages
 * are served from the same content origin and know the session token.
 */

export function signDocumentHandle(secret: Buffer, token: string, host: string): string {
  const payload = Buffer.from(
    JSON.stringify({ t: token, h: host, e: Date.now() + 6 * 3_600_000 }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32);
  return `${payload}.${signature}`;
}

export function verifyDocumentHandle(
  secret: Buffer,
  handle: string,
  token: string,
): { host: string } | null {
  const [payload, signature] = handle.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32);
  if (signature.length !== expected.length) return null;
  // Constant-time comparison for the signature.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (mismatch !== 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      t?: string;
      h?: string;
      e?: number;
    };
    if (parsed.t !== token || typeof parsed.h !== 'string' || !parsed.e || parsed.e < Date.now()) return null;
    return { host: parsed.h };
  } catch {
    return null;
  }
}
