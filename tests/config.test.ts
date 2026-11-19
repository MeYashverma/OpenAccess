import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

describe('public origin configuration', () => {
  it('uses Render\'s external URL unless PUBLIC_ORIGIN is explicit', () => {
    expect(loadConfig({ RENDER_EXTERNAL_URL: 'https://openaccess.onrender.com' }).publicOrigin).toBe(
      'https://openaccess.onrender.com',
    );
    expect(
      loadConfig({
        RENDER_EXTERNAL_URL: 'https://openaccess.onrender.com',
        PUBLIC_ORIGIN: 'https://browse.example.com/',
      }).publicOrigin,
    ).toBe('https://browse.example.com');
    expect(loadConfig({}).publicOrigin).toBeNull();
  });

  it('raises the upstream header limit above the 16 KiB default', () => {
    expect(loadConfig({}).maxUpstreamHeaderBytes).toBe(128 * 1024);
    expect(loadConfig({ MAX_UPSTREAM_HEADER_KB: '64' }).maxUpstreamHeaderBytes).toBe(64 * 1024);
    expect(loadConfig({ MAX_UPSTREAM_HEADER_KB: '1' }).maxUpstreamHeaderBytes).toBe(16 * 1024);
    expect(loadConfig({ MAX_UPSTREAM_HEADER_KB: '9999' }).maxUpstreamHeaderBytes).toBe(512 * 1024);
  });
});
