interface ImportMetaEnv {
  /** Optional Solana mainnet RPC (e.g. a Helius key) for the Scan, and for the Vault or Bounty on mainnet. Defaults to a public mainnet RPC. */
  readonly VITE_SOLANA_RPC?: string;
  /** Optional devnet RPC for the Vault or Bounty on devnet. Defaults to the public devnet RPC. */
  readonly VITE_DEVNET_RPC?: string;
  /** Cluster of the bounty program (the canary): 'devnet' (default) or 'mainnet'. Anything else fails the build. */
  readonly VITE_CANARY_CLUSTER?: string;
  /** Cluster of the vault program: 'devnet' (default) or 'mainnet'. Anything else fails the build. */
  readonly VITE_VAULT_CLUSTER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
