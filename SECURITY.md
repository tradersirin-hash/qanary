# Security policy

## Reporting a vulnerability

Please report privately. Do not open a public issue or pull request, and do not post details publicly.

- **Preferred:** open a private report at https://github.com/tradersirin-hash/qanary/security/advisories/new
- **Otherwise:** send a direct message to [@Qanaryxyz](https://x.com/Qanaryxyz) on X, and we will move the details to a private advisory.

Builds of both on-chain programs from this repository embed the same contacts as a [security.txt](https://github.com/neodyme-labs/solana-security-txt), which explorers show on the program page once such a build is deployed.

## Scope

| Component | Where |
| --- | --- |
| Qanary Vault program (`DoYraMDno33DYCUytDMvdGWWcsNz1Qm983K15pHnzaqu`) | `onchain/programs/qanary_vault` |
| Qanary Bounty program, the quantum canary (`HhrtGaEUk6Tar4cdCHkgTZj7jY5YXha4wjfdm8EteXRV`) | `onchain/programs/qanary_bounty` |
| Web app at https://qanary.xyz, including the recovery phrase, LM-OTS key derivation and signing, and Scan | `app/` |
| Canary watchdog, the scheduled workflow that trips the canary when the honeypot drops | `.github/workflows/watchdog.yml` and its script in `app/` |

The program ids are the same on every cluster. Out of scope: third-party RPC providers, wallets and Solana itself (report those to their maintainers), and denial of service through spam or rate limits.

## Status

- Both programs are unaudited research code.
- Qanary Vault runs on devnet only and stays there until an independent audit. Do not use it with real funds.
- Qanary Bounty runs on devnet; a mainnet deployment of the canary is planned.

## What to include

- The affected component, and the commit or deployed program and cluster.
- What an attacker can do, and under which conditions.
- Steps to reproduce: a transaction on devnet, a local test (the programs' LiteSVM tests are a good starting point), or a browser and app version for the web app.
- A suggested fix, if you have one, and how you would like to be credited.

Test on devnet or locally. Never move or lock funds that are not yours.

## What to expect

- We aim to acknowledge a report within a few days and to keep you updated until it is resolved.
- Once a fix is out, we publish an advisory and credit you unless you prefer otherwise. Please give us reasonable time to fix before disclosing.
- There is no bug bounty program, and no reward is promised for reports.

The SOL pool in Qanary Bounty is the quantum canary, not a reward for reports: only a valid signature for its nothing-up-my-sleeve key can claim it. A way to take that pool, or to trip the canary, without such a signature is a vulnerability: please report it privately like any other.
