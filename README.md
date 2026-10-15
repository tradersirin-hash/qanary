# Qanary

**The quantum canary for Solana.** See what a quantum computer could take, keep funds behind hash-based post-quantum signatures, and give every program a public on-chain flag that flips once someone proves elliptic-curve keys can be broken.

**Live:** https://qanary.xyz (Scan on mainnet, read-only; Vault and Bounty on devnet) · **X:** [@Qanaryxyz](https://x.com/Qanaryxyz)

Every standard Solana address *is* an Ed25519 public key. Google Quantum AI estimated in March 2026 that 256-bit elliptic-curve keys could fall to fewer than 500,000 physical qubits. Solana's core teams picked Falcon for future post-quantum wallets but say no change is required today, and nobody gets warned when the threat arrives. Qanary does three things:

| Part | What it does | Code |
|---|---|---|
| **Qanary Scan** | Paste a Solana or EVM address. See whether its key is exposed, how much value sits behind it, and which authorities (upgrade, mint, freeze, permanent delegate, stake withdrawer, ...) are Ed25519 keys, alone or as the signers of an SPL Token multisig. Includes a sourced Q-Day clock. | `app/` |
| **Qanary Vault** | Holds SOL (the program also handles SPL / Token-2022 tokens, with the exceptions under Honest claims; the web app moves SOL only) behind **LM-OTS one-time signatures** (RFC 8554, NIST SP 800-208 parameter set `LMOTS_SHA256_N24_W8`). Each action is signed by the current one-time key and commits to the next, so keys never repeat while the vault address stays fixed. An optional Ed25519 owner, added only by a post-quantum signature, can withdraw day to day while the canary lives. | `onchain/programs/qanary_vault` |
| **Qanary Bounty** | The canary: a SOL bounty behind an Ed25519 key that nobody knows the private key of (a nothing-up-my-sleeve point). Claiming it requires breaking Ed25519 and permanently sets a public `tripped` flag. A honeypot balance at the same key also trips the flag once anyone runs the watchdog after it drops. | `onchain/programs/qanary_bounty` |

## How the pieces fit

```
          Qanary Scan ──── "your key is exposed" ────► Qanary Vault
                                                          │
   Ed25519 owner path (convenience) ── allowed only while ─┤
                                                          │ reads `tripped`
   LM-OTS path (post-quantum) ─────── always allowed      ▼
                                                     Qanary Bounty (canary)
```

## Design notes

- **Signature scheme.** LM-OTS with SHA-256/192 and Winternitz w = 8: 26 hash chains, 652-byte signatures, security resting only on SHA-256. That fits a normal 1,232-byte Solana transaction, so ordinary wallets (Phantom, Solflare, Backpack) can pay the fee and submit it. Verification runs in the program with the `sol_sha256` syscall. To keep compute low, the browser derives 64 candidate randomizers deterministically from the secret seed and the message and signs with the one that is cheapest to verify, so the same request always yields the same signature.
- **Key chain.** Key `q` signs `domain || action || program || vault || q || next_key || params`. The program checks it, then stores `next_key`. A verified signature always consumes its key, even if the request cannot run (it is then skipped), so a key is never left half-used.
- **Unhijackable address.** The vault address is derived from its id *and* key 0, and new vaults start with no classical owner. A front-runner can only create the exact vault the user asked for.
- **One recovery phrase.** A 24-word BIP-39 phrase derives the vault id and the LM-OTS seed (RFC 8554 Appendix A key derivation). Signatures are deterministic, so retrying a request yields identical bytes on any device; the browser refuses to sign a different request with a key that is still pending, and refuses to sign at all if site storage is blocked.
- **Canary key.** `4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ` = 8 · decompress(SHA-256("Qanary canary v1: nobody knows the private key of this point" ‖ 0x01)). Reproduce it with `onchain/scripts/canary_key.py`; `tests/test_canary_key.rs` re-derives it with curve25519-dalek.
- **Cross-checked.** The Rust verifier and the TypeScript signer share known-answer tests, including a message and signature produced by the browser and verified by the program. Both also reproduce the independent RFC 9858 Test Case 1 (LMS_SHA256_M24_H5 with LMOTS_SHA256_N24_W8) byte for byte: the signer regenerates the published signature from its seed, and the verifier recovers the published public key.
- **A verified signature always consumes its key.** Whatever the signed message fixes, or what other people or time can change (a closed, frozen or paused account, a memo-required destination), is checked only after the signature verifies; a request that cannot run is skipped with an `ActionSkipped` event and a reason code. Accounts the message does not fix (the token program, the vault's associated token account) are checked before it, so whoever submits the transaction cannot burn the key with wrong ones.
- **Keys per cluster.** The phrase derives different vault ids and one-time keys on each cluster, so it never signs with the same one-time key on devnet and mainnet. Devnet keeps the original derivation.

## Run it

```bash
# Web app (Windows or any OS with Node 22)
cd app && npm install && npm run dev

# Programs (WSL / Linux / macOS with Agave 4.3 and Anchor 1.2.1)
cd onchain && bash scripts/wsl-build.sh
```

`app/.npmrc` disables install scripts; dependencies are pinned exactly. The web app has one page per part (`/`, `/how`, `/vault`, `/bounty`, `/qday`, `/roadmap`); `app/vercel.json` serves `index.html` for those paths.

## Business model

Scan stays free and the canary flag stays a public good. The plan, none of it live yet: a **Qanary API** for wallets, exchanges and custodians; **Qanary Watchtower**, paid monitoring and alerts for a team's addresses, programs and mints; **quantum-readiness reports** for protocols and treasuries; paid **canary integration** for protocols, multisigs and DAOs once the canary is audited and immutable on mainnet; and **Qanary Vault Pro** with treasury policies, only after an independent audit. Canary alerts will be free for everyone, and a share of paid revenue is meant to top up the bounty pool. See the site's Roadmap page.

## Honest claims

- Qanary does not make Solana, or any SPL token, quantum-proof. The vault protects the funds it holds; fee payers and other Ed25519 accounts stay classical.
- The canary is a public signal that an attacker chooses to send, not a detector. It cannot stop the first attacker, and a silent attacker who never touches it is never flagged. While it is untripped, a vault with a classical owner is exactly as safe as that owner's Ed25519 key, which is why wallet access is off by default.
- On devnet both programs are upgradeable by a classical (Ed25519) deployer key, so a key-breaker could replace them. Before mainnet the bounty must be made immutable and the vault's upgrade authority handed to a post-quantum-governed program.
- The deployed devnet bytecode matches our own local build by hash. That is not a reproducible "verified build".
- Before signing, the app takes a lock across this site's tabs and checks this browser and the vault's recent on-chain history for a request the current one-time key already signed (a failed transaction from another device included), and will then only re-send that request. Two devices signing *different* requests at the same moment, before either lands, would still weaken the key; use one device at a time.
- Token withdrawals are not supported for mints with a transfer hook, the NonTransferable extension or a paused Pausable config, or into destinations that require memos or accept only confidential credits. The program skips such a request (the one-time key is consumed, nothing moves) instead of failing. Tokens must sit in the vault's associated token account. The web app only moves SOL.
- Qanary Scan reads through third-party public RPC endpoints (and Jupiter's price API), which can see which addresses are looked up.
- No quantum computer can break 256-bit elliptic-curve keys today. The public record is a 15-bit key (April 2026).
- The programs are unaudited research code running on devnet. Do not use them with real funds.
