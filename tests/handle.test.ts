import { describe, expect, it } from 'vitest';
import { signDocumentHandle, verifyDocumentHandle } from '../src/server/handle.js';

const secret = Buffer.from('test-secret');
const token = 'T'.repeat(32);

describe('document handles', () => {
  it('round-trips the host for the session that owns it', () => {
    const handle = signDocumentHandle(secret, token, 'example.com');
    expect(verifyDocumentHandle(secret, handle, token)).toEqual({ host: 'example.com' });
  });

  it('rejects a handle minted for another session', () => {
    const handle = signDocumentHandle(secret, token, 'example.com');
    expect(verifyDocumentHandle(secret, handle, 'U'.repeat(32))).toBeNull();
  });

  it('rejects tampering with the host or expiry', () => {
    const handle = signDocumentHandle(secret, token, 'example.com');
    const [payload, signature] = handle.split('.');
    const parsed = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    parsed.h = 'evil.example';
    const forgedPayload = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    expect(verifyDocumentHandle(secret, `${forgedPayload}.${signature}`, token)).toBeNull();
    expect(verifyDocumentHandle(secret, 'garbage', token)).toBeNull();
    expect(verifyDocumentHandle(Buffer.from('other'), handle, token)).toBeNull();
  });

  it('expires handles', () => {
    const handle = signDocumentHandle(secret, token, 'example.com');
    const [payload, signature] = handle.split('.');
    const parsed = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    parsed.e = Date.now() - 1000;
    const expiredPayload = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    const forgedSignature = require('node:crypto')
      .createHmac('sha256', secret)
      .update(expiredPayload)
      .digest('base64url')
      .slice(0, 32);
    expect(verifyDocumentHandle(secret, `${expiredPayload}.${forgedSignature}`, token)).toBeNull();
  });
});
