interface ImportMetaEnv {
  /** Optional Solana RPC endpoint (e.g. a Helius key). Defaults to the public mainnet RPC. */
  readonly VITE_SOLANA_RPC?: string;
  /** Optional devnet RPC for the vault demo. Defaults to the public devnet RPC. */
  readonly VITE_DEVNET_RPC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
