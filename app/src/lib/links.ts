import type { Cluster } from './cluster';

/** Public origin; canonical and og:url point here (see index.html). */
export const SITE_URL = 'https://qanary.xyz';
/** Fill in only when the GitHub repo is public. Empty hides every repo link. */
export const REPO_URL = 'https://github.com/tradersirin-hash/qanary';
export const X_URL = 'https://x.com/Qanaryxyz';
export const explorer = (cluster: Cluster, path: string) => `https://explorer.solana.com/${path}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
export const TELEGRAM_URL = 'https://t.me/qanaryxyz';
/** Solana's web faucet for devnet SOL, for when the RPC airdrop is rate-limited. */
export const FAUCET_URL = 'https://faucet.solana.com';
export const solscan = (addr: string) => `https://solscan.io/account/${addr}`;
export const solscanToken = (mint: string) => `https://solscan.io/token/${mint}`;
export const pumpFun = (mint: string) => `https://pump.fun/coin/${mint}`;
export const etherscan = (addr: string) => `https://etherscan.io/address/${addr}`;
export const STANDARDS = [
  { label: 'stdRfc', url: 'https://www.rfc-editor.org/rfc/rfc8554' },
  { label: 'stdSp', url: 'https://csrc.nist.gov/pubs/sp/800/208/final' },
  { label: 'stdIr', url: 'https://csrc.nist.gov/pubs/ir/8547/ipd' },
] as const;
