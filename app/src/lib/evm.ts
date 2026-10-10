import { createPublicClient, fallback, formatEther, http, type Address, type Chain } from 'viem';
import { arbitrum, base, mainnet, robinhood } from 'viem/chains';

const NETWORKS: { chain: Chain; rpc?: string }[] = [
  { chain: mainnet, rpc: 'https://ethereum-rpc.publicnode.com' },
  { chain: robinhood },
  { chain: arbitrum },
  { chain: base },
];

/** 'exposed': the key has signed a transaction, so its public key is on-chain.
 *  'notSeen': no outgoing transaction on this chain.
 *  'delegated': an EIP-7702 EOA; setting the delegation required a signature, so the key is public.
 *  'contract': contract code, no private key behind the address. */
export type EvmStatus = 'exposed' | 'notSeen' | 'delegated' | 'contract';

export type EvmChainResult = {
  chainId: number;
  name: string;
  symbol: string;
  explorer?: string;
  nonce?: number;
  balance?: string;
  status?: EvmStatus;
  error?: boolean;
};

/** 'unknown': nothing exposed was found, but some chains could not be checked. */
export type EvmOverall = 'exposed' | 'notSeen' | 'contract' | 'unknown';

export type EvmReport = { kind: 'evm'; address: Address; overall: EvmOverall; chains: EvmChainResult[] };

export async function scanEvm(addr: Address): Promise<EvmReport> {
  const chains = await Promise.all(
    NETWORKS.map(async ({ chain, rpc }): Promise<EvmChainResult> => {
      const info = { chainId: chain.id, name: chain.name, symbol: chain.nativeCurrency.symbol, explorer: chain.blockExplorers?.default.url };
      try {
        // Public RPCs sometimes drop CORS headers under load, so fall back across every listed endpoint.
        const urls = rpc ? [rpc] : chain.rpcUrls.default.http;
        const transport = fallback(urls.map((url) => http(url, { timeout: 12_000, retryCount: 1 })));
        const client = createPublicClient({ chain, transport });
        const [nonce, balance, code] = await Promise.all([
          client.getTransactionCount({ address: addr }),
          client.getBalance({ address: addr }),
          client.getCode({ address: addr }),
        ]);
        const delegated = !!code && code.toLowerCase().startsWith('0xef0100');
        const isContract = !!code && code !== '0x' && !delegated;
        const status: EvmStatus = isContract ? 'contract' : delegated ? 'delegated' : nonce > 0 ? 'exposed' : 'notSeen';
        return { ...info, nonce, balance: formatEther(balance), status };
      } catch {
        return { ...info, error: true };
      }
    }),
  );

  const reachable = chains.filter((c) => !c.error);
  if (reachable.length === 0) throw new Error('No EVM RPC reachable');

  // One signature on any chain reveals the key everywhere, so exposure on one chain decides the verdict.
  const overall: EvmOverall = reachable.some((c) => c.status === 'exposed' || c.status === 'delegated')
    ? 'exposed'
    : reachable.some((c) => c.status === 'contract')
      ? 'contract'
      : reachable.length < chains.length
        ? 'unknown'
        : 'notSeen';

  return { kind: 'evm', address: addr, overall, chains };
}
