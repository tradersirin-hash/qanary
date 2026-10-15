import { afterEach, describe, expect, it, vi } from 'vitest';
import { clusterConfig, parseCluster } from './cluster';
import { explorer } from './links';

describe('parseCluster', () => {
  it('defaults to devnet when unset or empty', () => {
    expect(parseCluster('VITE_CANARY_CLUSTER', undefined)).toBe('devnet');
    expect(parseCluster('VITE_CANARY_CLUSTER', '')).toBe('devnet');
  });

  it('accepts exactly devnet and mainnet', () => {
    expect(parseCluster('VITE_VAULT_CLUSTER', 'devnet')).toBe('devnet');
    expect(parseCluster('VITE_VAULT_CLUSTER', 'mainnet')).toBe('mainnet');
  });

  it('throws on anything else, naming the setting, instead of picking a cluster', () => {
    for (const bad of ['mainnet-beta', 'Mainnet', ' mainnet', 'testnet', 'localnet', 'true']) {
      expect(() => parseCluster('VITE_CANARY_CLUSTER', bad), bad).toThrow(/VITE_CANARY_CLUSTER/);
    }
  });
});

describe('clusterConfig', () => {
  it('uses the public RPCs by default (mainnet: the same one as the Scan)', () => {
    expect(clusterConfig('devnet', {}).rpc).toBe('https://api.devnet.solana.com');
    expect(clusterConfig('mainnet', {}).rpc).toBe('https://solana-rpc.publicnode.com');
  });

  it('takes each cluster RPC from its own variable only', () => {
    const env = { VITE_DEVNET_RPC: 'https://devnet.example', VITE_SOLANA_RPC: 'https://mainnet.example' };
    expect(clusterConfig('devnet', env).rpc).toBe('https://devnet.example');
    expect(clusterConfig('mainnet', env).rpc).toBe('https://mainnet.example');
    expect(clusterConfig('devnet', { VITE_SOLANA_RPC: 'https://mainnet.example' }).rpc).toBe('https://api.devnet.solana.com');
    expect(clusterConfig('mainnet', { VITE_DEVNET_RPC: 'https://devnet.example' }).rpc).toBe('https://solana-rpc.publicnode.com');
  });

  it('signs on the matching Wallet Standard chain', () => {
    expect(clusterConfig('devnet', {}).chain).toBe('solana:devnet');
    expect(clusterConfig('mainnet', {}).chain).toBe('solana:mainnet');
  });

  it('offers an airdrop on devnet only', () => {
    expect(clusterConfig('devnet', {}).airdrop).toBe(true);
    expect(clusterConfig('mainnet', {}).airdrop).toBe(false);
  });
});

describe('explorer', () => {
  it('adds ?cluster=devnet on devnet only', () => {
    expect(explorer('devnet', 'address/abc')).toBe('https://explorer.solana.com/address/abc?cluster=devnet');
    expect(explorer('devnet', 'tx/sig')).toBe('https://explorer.solana.com/tx/sig?cluster=devnet');
    expect(explorer('mainnet', 'address/abc')).toBe('https://explorer.solana.com/address/abc');
    expect(explorer('mainnet', 'tx/sig')).toBe('https://explorer.solana.com/tx/sig');
  });
});

describe('build settings', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const load = async (canary: string | undefined, vault: string | undefined) => {
    vi.stubEnv('VITE_CANARY_CLUSTER', canary);
    vi.stubEnv('VITE_VAULT_CLUSTER', vault);
    vi.resetModules();
    return import('./constants');
  };

  it('puts both programs on devnet by default', async () => {
    const c = await load(undefined, undefined);
    expect(c.CANARY_CLUSTER).toBe('devnet');
    expect(c.VAULT_CLUSTER).toBe('devnet');
  });

  it('sets each program cluster on its own', async () => {
    const c = await load('mainnet', undefined);
    expect(c.CANARY_CLUSTER).toBe('mainnet');
    expect(c.VAULT_CLUSTER).toBe('devnet');
    expect(c.NETWORKS[c.CANARY_CLUSTER].chain).toBe('solana:mainnet');
    expect(c.NETWORKS[c.VAULT_CLUSTER].airdrop).toBe(true);
  });

  it('fails at startup on an invalid value', async () => {
    await expect(load('mainnet-beta', undefined)).rejects.toThrow(/VITE_CANARY_CLUSTER/);
    await expect(load(undefined, 'Mainnet')).rejects.toThrow(/VITE_VAULT_CLUSTER/);
  });
});
