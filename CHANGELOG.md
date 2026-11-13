# Changelog

Notable changes to Qanary are listed here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

On mainnet-prep; ships as 1.1.0 when merged into main (planned 2026-12-06 to 12-08).

### Security

- One-time keys are guarded across tabs and devices. Signing holds a lock shared by the site's tabs, and before every signature the app reads the vault's on-chain history back to the current key: a different request already signed elsewhere is refused, nothing is signed when that history cannot be read in full, and re-sending a create that already landed opens the existing vault. (6687af0, db29f4f, 8179a0d)
- A post-quantum request whose signature verifies always consumes its one-time key; a request that can no longer run is skipped with a reason code. (f735fa8)
- A strict Content-Security-Policy and security headers: scripts load only from the site, network requests go only to the listed RPC and price hosts (Helius RPC hosts included), and framing is denied. (3a36911, 0730a53)
- Vault keys are derived per cluster, so one recovery phrase never signs with the same one-time key on two clusters. Devnet vaults still open from the same phrase. (ab88ef4)
- The one-time-key record that every tab shares is read before the copy in this page's memory, so a failed storage write cannot lead to a key signing two requests. (1c65e33)
- Vite 8.3.5 and source-map-js 1.2.2 fix high-severity advisories in the build tools, which the site never shipped, and CI now also fails on a high-severity advisory anywhere in the npm tree. (603bfa0)

### Added

- Creating a vault asks for three words of the new recovery phrase before the create button unlocks. (8b22a86)
- The LM-OTS signer and verifier are checked against the RFC 9858 test vectors, with property tests and a bound on the verifier's worst-case compute cost. (87ee17c, 524e100)
- Both programs embed a security.txt and build smaller, and a mainnet deploy script is a dry run until `--yes`. (c6c7fea)
- The build settings `VITE_CANARY_CLUSTER` and `VITE_VAULT_CLUSTER` choose devnet or mainnet for the canary and the vault, and the watchdog has a mainnet job that stays off until it is enabled. (afb4fdd)
- The README gives the canary-first mainnet launch steps. (1198f18)
- The watchdog raises the honeypot baseline to the current balance and alerts when the canary key signs a transaction. The site and the watchdog read the honeypot and its baseline in one call. (72d5033, 82b38d7)
- CI builds both programs for SBF from the committed Cargo.lock and runs every Rust test, the LiteSVM suites included. It fails when the test count the site states is out of date or the CSP does not allow a configured RPC host. (51e2180, f8fb1c0, 69a196c, ea813cb)
- CI checks Rust formatting, clippy and npm advisories. (7fe2d65, d517968, e212d4b)
- Tests pin the canary and vault account layouts and every signed vault message; initialization-order tests for the canary. (bcea601, 8357ad8, 189e0e3)
- A canary incident runbook linked from every watchdog alert. A different alert status opens its own issue, and the watchdog alerts when it cannot read the canary key's whole recent history. (5ad86ec, 306dbb3)
- Each completed scan adds one to a daily total through `/api/scan-count`: an empty request with no address, cookie or Referer. Counting stays off until a counter database is connected. (148c9fa)

### Changed

- Scan says what it reads, and an exposed key is "Quantum-exposed" and not exploitable today. A multisig that one key can use shows red, like a lone key. (5047932, 74e0243)
- The planned monitoring tier is now called Qanary Watch. (d012044)
- The homepage no longer has the token band; the mint address and disclaimer stay in the footer. (628d50b)
- The homepage asks who can change the tokens and programs you rely on. Its examples are neutral: the Jupiter program, the wrapped SOL mint and the SPL Token program. EVM addresses still get a basic key check. (4b534b6)
- The README and the page descriptions say what Qanary shows: who can change the programs and tokens you rely on, how strong that control is, and which of those keys a future quantum computer could break. (fb1b2ae)
- The Roadmap lists Qanary Watch as a free beta on Telegram, for programs and tokens a team depends on but does not run, instead of a monthly subscription. (ea9713f)

### Fixed

- The Bounty page and the home status strip show a drained honeypot as Drained in red instead of Alive, with the check that trips the flag. (2dadfb2)
- A damaged one-time-key record in browser storage stops signing with a clear message instead of an internal error. (e17aafa)
- An RPC error while waiting for a sent transaction reports that it may still land, with the explorer link. (2e64cad, 5a498a7)
- An incomplete canary read is refused instead of shown as drained. (a421080, 267e065)
- A watchdog alert step that cannot list the open issues fails instead of dropping the alert. (6c32450)

## [1.0.0]

What qanary.xyz serves during the hackathon judging (main).

- Scan: Solana, plus the EVM basic check.
- The Vault on devnet.
- The Bounty canary on devnet, and the watchdog.
- The November 2026 readiness census (aggregates).
- The hotfixes on main during judging: security headers with a report-only CSP (637871c), the watchdog baseline ratchet and signature watch (73f25f5), the Qanary Watch rename and prior art (adfaa20, 8ffc2e6), keeping the site build identical (2945a73), the canary runbook linked from every watchdog alert (e056b6b), and the hash of the census's private per-address output (b1f1044). Tagged `v1.0.0` at b1f1044.
