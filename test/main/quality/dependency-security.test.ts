import { describe, expect, it } from 'vitest';

const proxyaddr = require('proxy-addr');
const { SourceMapConsumer } = require('source-map-js');

describe('dependency security boundaries', () => {
  it.each(['203.0.113.9', '::ffff:203.0.113.9'])(
    'does not accept a forwarded identity from an untrusted peer %s', address => {
      const request = {
        socket: { remoteAddress: address },
        headers: { 'x-forwarded-for': '192.0.2.10' },
      };
      for (const ranges of [['::ffff:10.0.0.0/8'], ['::ffff:10.0.0.0/8', '::1/128']]) {
        expect(proxyaddr(request, proxyaddr.compile(ranges))).toBe(address);
      }
    },
  );

  it('preserves explicitly trusted IPv4-mapped proxy subnets', () => {
    const request = {
      socket: { remoteAddress: '::ffff:10.2.3.4' },
      headers: { 'x-forwarded-for': '192.0.2.10' },
    };
    expect(proxyaddr(request, proxyaddr.compile('::ffff:10.0.0.0/104'))).toBe('192.0.2.10');
  });

  const leaf = { version: 3, sources: ['input.js'], names: [], mappings: 'AAAA' };
  const indexed = (line: number, map: unknown = leaf) => ({
    version: 3, sections: [{ offset: { line, column: 0 }, map }],
  });

  it('rejects tiny source maps that would amplify into enormous generated output', () => {
    // Construction must reject the input before a build tool serializes it.
    // Do not actually allocate the unbounded output on an unpatched version.
    expect(() => new SourceMapConsumer(indexed(1_000_000_000))).toThrow();
    expect(() => new SourceMapConsumer(indexed(6_000_000, indexed(6_000_000)))).toThrow();
  });

  it('preserves ordinary indexed source-map locations', () => {
    const consumer = new SourceMapConsumer(indexed(2));
    const mappings: unknown[] = [];
    consumer.eachMapping((mapping: unknown) => mappings.push(mapping));
    expect(mappings).toEqual([expect.objectContaining({
      source: 'input.js', generatedLine: 3, generatedColumn: 0,
      originalLine: 1, originalColumn: 0,
    })]);
  });
});
