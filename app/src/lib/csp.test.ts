import { describe, expect, it } from 'vitest';
import vercel from '../../vercel.json' with { type: 'json' };
import { clusterConfig, DEVNET_PUBLIC_RPC, MAINNET_PUBLIC_RPC } from './cluster';
import { allowsConnect, connectSources } from './csp';
import { EVM_RPC_URLS } from './evm';
import { JUP } from './jupiter';

const sources = connectSources(vercel);

describe('connect-src of the Content-Security-Policy in vercel.json', () => {
  it('limits where the page can connect', () => {
    expect(sources).not.toBeNull();
  });

  it('allows every RPC and API the app reads by default', () => {
    for (const url of [DEVNET_PUBLIC_RPC, MAINNET_PUBLIC_RPC, ...EVM_RPC_URLS, JUP]) expect(allowsConnect(sources, url), url).toBe(true);
  });

  it('allows the RPCs this environment configures (VITE_SOLANA_RPC, VITE_DEVNET_RPC)', () => {
    for (const cluster of ['devnet', 'mainnet'] as const) {
      const { rpc } = clusterConfig(cluster, import.meta.env);
      expect(allowsConnect(sources, rpc), cluster).toBe(true);
    }
  });

  it('allows the keyed Helius RPCs on any path, with any API key', () => {
    expect(allowsConnect(sources, 'https://mainnet.helius-rpc.com/?api-key=key')).toBe(true);
    expect(allowsConnect(sources, 'https://devnet.helius-rpc.com/?api-key=key')).toBe(true);
  });
});

describe('allowsConnect', () => {
  const list = ["'self'", 'https://rpc.example', 'https://*.example.org', 'wss:'];

  it('needs the same scheme, host and port', () => {
    expect(allowsConnect(list, 'https://rpc.example/path?key=1')).toBe(true);
    expect(allowsConnect(list, 'http://rpc.example')).toBe(false);
    expect(allowsConnect(list, 'https://rpc.example:8899')).toBe(false);
    expect(allowsConnect(list, 'https://rpc.example.evil')).toBe(false);
    expect(allowsConnect(list, 'https://other.example')).toBe(false);
  });

  it('lets *. cover subdomains only, and a bare scheme cover every host', () => {
    expect(allowsConnect(list, 'https://a.example.org')).toBe(true);
    expect(allowsConnect(list, 'https://example.org')).toBe(false);
    expect(allowsConnect(list, 'wss://any.host')).toBe(true);
  });

  it('refuses a URL that does not parse, and allows anything without a policy', () => {
    expect(allowsConnect(list, 'rpc.example')).toBe(false);
    expect(allowsConnect(null, 'https://any.host')).toBe(true);
  });
});

describe('connectSources', () => {
  const policy = (value: string) => ({ headers: [{ headers: [{ key: 'Content-Security-Policy', value }] }] });

  it('reads connect-src, or default-src when there is none', () => {
    expect(connectSources(policy("default-src 'self'; connect-src 'self' https://a.example"))).toEqual(["'self'", 'https://a.example']);
    expect(connectSources(policy("default-src 'self' https://b.example; img-src data:"))).toEqual(["'self'", 'https://b.example']);
  });

  it('is null without a policy, or with one that does not limit connections', () => {
    expect(connectSources({})).toBeNull();
    expect(connectSources({ headers: [{ headers: [{ key: 'X-Frame-Options', value: 'DENY' }] }] })).toBeNull();
    expect(connectSources(policy("img-src 'self'"))).toBeNull();
  });
});
