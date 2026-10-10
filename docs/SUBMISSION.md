# Qanary: submission notes

## One-liner

Qanary is the quantum canary for Solana: a scanner that shows what a quantum computer could take, a vault that keeps funds behind hash-based post-quantum signatures, and a public on-chain flag that closes classical paths once someone proves elliptic-curve keys can be broken.

## Problem

- Every standard Solana address is an Ed25519 public key, so every wallet's key is public by design.
- In March 2026 Google Quantum AI estimated that 256-bit elliptic-curve keys could fall to under 500,000 physical qubits, minutes per key. Expert surveys put a cryptographically relevant quantum computer at 28–49% within 10 years.
- Solana's core teams (Anza, Firedancer) plan post-quantum wallets "if the threat becomes credible". Today users have no app-layer protection, and nobody gets warned when the threat arrives.

## What we built

1. **Qanary Scan** (live web app). Paste any Solana or EVM address. It shows whether the key is exposed, the value behind it, and every authority that controls the account: upgrade authority, mint and freeze authority, Token-2022 permanent delegate, stake withdrawer, nonce authority and more. A sourced Q-Day clock tracks attack-cost estimates and migration deadlines.
2. **Qanary Vault** (Anchor program). SOL and SPL tokens (program-level; the web app moves SOL only) behind LM-OTS one-time signatures (RFC 8554, NIST SP 800-208 parameter set `LMOTS_SHA256_N24_W8`). A signature is 652 bytes, so it fits a normal transaction any wallet can pay for. Each action commits to the next key: keys never repeat, and the vault address never changes. A 24-word phrase is the only secret.
3. **Qanary Bounty** (Anchor program). A SOL bounty behind an Ed25519 key that nobody knows the private key of (a nothing-up-my-sleeve curve point, reproducible by anyone). Claiming it requires breaking Ed25519 and permanently sets a public `tripped` flag. A honeypot balance at the same key also trips it once the watchdog sees a drop.

The vault reads the canary: an optional Ed25519 owner (off by default, added only by a post-quantum signature) can withdraw day to day while the canary lives. Once it trips, only post-quantum signatures can move funds. The canary is a signal the attacker chooses to send, not a detector; we say so in the app.

## Why it matters

- Real cryptography, not branding: NIST-standardized hash-based signatures, verified on-chain with the `sol_sha256` syscall.
- Usable today: no protocol change, no special wallet. Phantom pays the fee; the browser signs the post-quantum part.
- A public good: the canary flag is a primitive any Solana program can read.

## Demo script (about 2 minutes)

1. **Scan** (30 s). Paste a large exchange wallet: "over a billion dollars behind one public key". Paste the USDC mint: mint and freeze authority are plain Ed25519 keys. Scroll the Q-Day clock.
2. **Vault** (60 s). Connect Phantom on devnet. Create a vault: show the 24-word phrase. Deposit 0.5 SOL. Withdraw 0.1 SOL with a post-quantum signature: the explorer shows the transaction, and the vault's key counter moves from 0 to 1.
3. **Canary** (30 s). Show the bounty pool and honeypot. Explain: the day someone signs for this key, the flag flips and every vault's classical path closes. Show the classical withdraw button disappearing when the canary is tripped (devnet test or recording).

## Honest limits

- Unaudited; devnet only. Both programs are still upgradeable by a classical (Ed25519) deployer key.
- The devnet bytecode matches our own local build by hash; that is not a reproducible "verified build".
- Token withdrawals can fail after signing, and are not supported, for mints with a transfer hook, NonTransferable or Pausable extensions, and for destinations that require memos. The web app only moves SOL.
- The scanner reads through third-party public RPC endpoints (and Jupiter's price API), which can see which addresses are looked up.
- The vault protects the funds it holds. Fee payers and other Ed25519 accounts stay classical.
- The canary cannot stop the first or a silent attacker; until it trips, wallet access is only as safe as the wallet's key.
- One-time keys must never sign two different messages: signatures are deterministic, the browser blocks conflicting requests, and the program consumes a key on every verified signature. Two devices used at once remain a risk.
- Reviewed by independent AI agents (two rounds, findings fixed and re-tested); not a professional audit.
- No quantum computer can break 256-bit elliptic-curve keys today. The public record is a 15-bit key (April 2026).

## Next

- Audit, then mainnet.
- Token-2022 and SPL withdrawals in the web app (already in the program).
- Canary flag adopted by other programs (multisigs, treasuries).
- `$QNRY`: fair launch with no presale; creator fees fund the bounty pool and an audit.
