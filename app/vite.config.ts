import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { clusterConfig, parseCluster, type Cluster, type RpcEnv } from './src/lib/cluster.ts';

/** The index.html descriptions, naming where the Vault and the Bounty (the canary) run. */
function descriptions(canary: Cluster, vault: Cluster): Record<string, string> {
  const canaryOn = canary === vault ? '' : ` on ${canary}`;
  const allOn = canary === vault ? ` on ${canary}` : '';
  const sol = vault === 'devnet' ? 'devnet SOL' : 'SOL';
  return {
    '%QANARY_DESCRIPTION%': `Scan any Solana or EVM address for quantum exposure, hold ${sol} behind LM-OTS post-quantum signatures, and watch an on-chain canary bounty${canaryOn}. Unaudited research${allOn}.`,
    '%QANARY_TWITTER_DESCRIPTION%': `Quantum-exposure scanner, post-quantum ${vault} vault and on-chain canary${canaryOn} for Solana. Unaudited research${allOn}.`,
  };
}

/** The origin of an RPC URL; null if it does not parse, which leaves its hint out. */
function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** index.html hints for the RPC hosts this build reads: a preconnect to the canary's cluster, which the home page reads
 *  first, then a dns-prefetch to the other cluster's if anything reads it (the Scan always reads mainnet). */
function rpcHints(canary: Cluster, vault: Cluster, env: RpcEnv): string {
  const other: Cluster = canary === 'devnet' ? 'mainnet' : 'devnet';
  const first = origin(clusterConfig(canary, env).rpc);
  const second = other === 'mainnet' || vault === 'devnet' ? origin(clusterConfig(other, env).rpc) : null;
  const tags = [first && `<link rel="preconnect" href="${first}" crossorigin />`, second && second !== first && `<link rel="dns-prefetch" href="${second}" />`];
  return tags.filter(Boolean).join('\n    ');
}

/** Fails the build on a VITE_CANARY_CLUSTER or VITE_VAULT_CLUSTER other than devnet or mainnet, and fills in the
 *  index.html descriptions and RPC hints for the clusters chosen. */
function clusters(env: Record<string, string>): Plugin {
  const canary = parseCluster('VITE_CANARY_CLUSTER', env.VITE_CANARY_CLUSTER);
  const vault = parseCluster('VITE_VAULT_CLUSTER', env.VITE_VAULT_CLUSTER);
  const text = { ...descriptions(canary, vault), '<!--qanary-rpc-hints-->': rpcHints(canary, vault, env) };
  return {
    name: 'qanary-clusters',
    transformIndexHtml: (html) => Object.entries(text).reduce((out, [placeholder, value]) => out.replaceAll(placeholder, value), html),
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), clusters(loadEnv(mode, '.', 'VITE_'))],
}));
