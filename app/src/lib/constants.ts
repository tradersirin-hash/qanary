// Plain strings so App, the footer and the stats strip never pull @solana/kit into the main bundle.
export const VAULT_PROGRAM_ID = 'DoYraMDno33DYCUytDMvdGWWcsNz1Qm983K15pHnzaqu';
export const BOUNTY_PROGRAM_ID = 'HhrtGaEUk6Tar4cdCHkgTZj7jY5YXha4wjfdm8EteXRV';
export const CANARY_KEY_ID = '4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ';
/** The official $QANARY token mint (pump.fun, Token-2022, no mint or freeze authority, fixed metadata). */
export const TOKEN_MINT = 'Baj1wjp5Pd8nWTqExnjpvfXzrhE1RvCgw2ZHSjZ9pump';
/** How many tokens the wallet card lists; only these get a symbol lookup. */
export const SHOWN_TOKENS = 8;
/** Rust tests passing in `onchain/` (`bash scripts/wsl-build.sh`); keep in sync with the suite. 0 hides the line. */
export const RUST_TEST_COUNT = 18;
