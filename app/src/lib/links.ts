/** Fill in only when the GitHub repo is public. Empty hides every repo link. */
export const REPO_URL = 'https://github.com/tradersirin-hash/qanary';
export const explorerDevnet = (path: string) => `https://explorer.solana.com/${path}?cluster=devnet`;
export const solscan = (addr: string) => `https://solscan.io/account/${addr}`;
export const etherscan = (addr: string) => `https://etherscan.io/address/${addr}`;
export const STANDARDS = [
  { label: 'stdRfc', url: 'https://www.rfc-editor.org/rfc/rfc8554' },
  { label: 'stdSp', url: 'https://csrc.nist.gov/pubs/sp/800/208/final' },
  { label: 'stdIr', url: 'https://csrc.nist.gov/pubs/ir/8547/ipd' },
] as const;
