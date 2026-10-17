import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { displayBrowserUrl } from '../../../src/main/features/web_assist_url';
import { displayUrl } from '../../../src/main/features/web_assist';

describe('browser URL evidence', () => {
  it('preserves business codes, keys and the exact hash router', () => {
    for (const url of ['https://example.org/?code=sku%201&key=record+2#/board?tab=1&key=k',
      'https://example.org/#/board?code=product%20id&key=k', 'https://example.org/#key=a+b']) {
      expect(displayUrl(url)).toBe(url);
      expect(displayBrowserUrl(url)).toBe(url);
      expect(runInNewContext(`(${displayBrowserUrl.toString()})(${JSON.stringify(url)})`, { URL, URLSearchParams })).toBe(url);
    }
  });
  it('redacts explicit credentials and structured OAuth responses while preserving route prefixes', () => {
    const ordinary = new URL(displayUrl('https://example.org/?code=sku&key=record&access_token=secret#/board?tab=1&token=fragment'));
    expect(ordinary.searchParams.get('code')).toBe('sku'); expect(ordinary.searchParams.get('key')).toBe('record');
    expect(ordinary.searchParams.get('access_token')).toBe('[redacted]');
    expect(ordinary.hash.startsWith('#/board?')).toBe(true); expect(ordinary.hash).not.toContain('fragment');
    for (const url of ['https://example.org/?code=oauth-secret&state=nonce', 'https://example.org/#code=oauth-secret&state=nonce']) {
      expect(displayUrl(url)).not.toContain('oauth-secret');
    }
    expect(displayBrowserUrl('https://user:password@example.org/?key=business')).toBe('https://example.org/?key=business');
  });
});
