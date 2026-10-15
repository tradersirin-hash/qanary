// Where the Vault and Bounty programs run, chosen at build time (VITE_VAULT_CLUSTER, VITE_CANARY_CLUSTER).
// Pure and free of @solana/kit, so the main bundle and vite.config.ts can both use it.

export type Cluster = 'devnet' | 'mainnet';

/** The same CORS-friendly public RPC the Scan uses (see solana.ts); api.mainnet-beta.solana.com refuses browsers. */
export const MAINNET_PUBLIC_RPC = 'https://solana-rpc.publicnode.com';
export const DEVNET_PUBLIC_RPC = 'https://api.devnet.solana.com';

/** Reads a cluster setting. Unset or empty means devnet; any other value but 'devnet' or 'mainnet' throws,
 *  so a typo can never fall through to mainnet. */
export function parseCluster(name: string, value: string | undefined): Cluster {
  if (value === undefined || value === '') return 'devnet';
  if (value === 'devnet' || value === 'mainnet') return value;
  throw new Error(`${name} must be "devnet" or "mainnet", not "${value}"`);
}

export type ClusterConfig = {
  cluster: Cluster;
  rpc: string;
  /** Wallet Standard chain the connected wallet signs and sends on. */
  chain: 'solana:devnet' | 'solana:mainnet';
  /** Only devnet has a faucet. */
  airdrop: boolean;
};

export type RpcEnv = { VITE_DEVNET_RPC?: string; VITE_SOLANA_RPC?: string };

export function clusterConfig(cluster: Cluster, env: RpcEnv): ClusterConfig {
  return cluster === 'devnet'
    ? { cluster, rpc: env.VITE_DEVNET_RPC || DEVNET_PUBLIC_RPC, chain: 'solana:devnet', airdrop: true }
    : { cluster, rpc: env.VITE_SOLANA_RPC || MAINNET_PUBLIC_RPC, chain: 'solana:mainnet', airdrop: false };
}
