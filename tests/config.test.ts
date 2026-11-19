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
});
