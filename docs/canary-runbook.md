# Canary incident runbook

What to do when the canary watchdog, the site or a report says something happened to the canary. The watchdog's alert issues are public the moment they open, so the first rule is: **verify on two independent sources before any public statement**, and until then add facts to the issue only.

The canary is the Qanary Bounty program's account `DDNM18i4XcRS2n2Uwh8BaYQcJhJZBz4hRjK4pyZbbq1Q` (the same address on every cluster, since the program id is the same). Its honeypot is the plain SOL at the canary key `4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ`, which only a signature by that key can move.

## 1. What can fire

- **A watchdog issue**, labelled `canary` (devnet) or `canary-mainnet`, titled `Canary watchdog (<cluster>): <status>`:
  - `tripped`: the flag is set on-chain.
  - `drained`: the honeypot fell below its baseline, but the watchdog could not send `check_honeypot` to trip the canary. The issue gives the error.
  - `signed`: the canary key signed a transaction in the last 48 hours, while the honeypot is not below its baseline.
  - `history_gap`: more transactions mentioned the canary key in the last 48 hours than the watchdog reads (`HISTORY_LIMIT`, 100 by default), so it could not rule out one the key signed. Anyone can cause this with dust transfers, about 0.0005 SOL in fees: it means "could not verify", not "broken".
  - `missing`: the canary account could not be read.
- **A failed run** of the Canary watchdog workflow: a fee payer that could not send a forced check or a baseline raise, a history that could not be read, an RPC that serves another cluster, or an RPC reply that left out an account. It opens no issue, so it shows only in the Actions tab and GitHub's failed-run notifications.
- **The red state on /bounty and in the home stats strip.** The site reads the canary live, and shows red when the flag is tripped or the honeypot is below its baseline.
- **An outside report** through [SECURITY.md](../SECURITY.md). Keep it private as that policy says, and verify it with the steps below like any alert.

## 2. Verify first

Use two independent sources: the cluster's public RPC and a keyed RPC from another provider, or one RPC and a block explorer. Read at commitment `finalized`, so the result cannot roll back; a fresh event finalizes about 15 seconds after it lands.

**The flag and the honeypot.** Read the canary (the Canary line of the issue, or `canary=` in the run log) and the honeypot in one `getMultipleAccounts` call, so both come from the same slot:

```sh
RPC=https://api.mainnet-beta.solana.com   # devnet: https://api.devnet.solana.com; then repeat with the second source
curl -s "$RPC" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getMultipleAccounts","params":[["DDNM18i4XcRS2n2Uwh8BaYQcJhJZBz4hRjK4pyZbbq1Q","4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ"],{"encoding":"base64","commitment":"finalized"}]}'
```

- `value[0].owner` must be the Bounty program `HhrtGaEUk6Tar4cdCHkgTZj7jY5YXha4wjfdm8EteXRV`, and `value[0].data[0]` is the canary account in base64, 66 bytes: discriminator 8 | tripped 1 | tripped_slot 8 | claimer 32 | honeypot_baseline 8 | total_funded 8 | bump 1. Byte 8 is `tripped` (1 when tripped); bytes 9..17 are `tripped_slot` and bytes 49..57 the baseline, both u64 little-endian (each range excludes its end). A claimer of all zero bytes means the canary was not tripped by a bounty claim.
- `value[1].lamports` is the honeypot balance; `value[1]` null means no account, so 0 lamports. A balance below the baseline is a drop.
- `context.slot` is the slot both were read at.

To decode the account data:

```sh
node -e 'const d = Buffer.from(process.argv[1], "base64"); console.log({ tripped: d[8] === 1, trippedSlot: d.readBigUInt64LE(9), baseline: d.readBigUInt64LE(49) })' '<value[0].data[0]>'
```

**For `signed`**, fetch the transaction on a second provider:

```sh
curl -s "$RPC" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":["<signature>",{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":1}]}'
```

The key signed only if it is among the first `transaction.message.header.numRequiredSignatures` entries of `transaction.message.accountKeys`; anywhere else it is only mentioned (an address lookup table can never supply a signer). A failed transaction (`meta.err` set) counts too: a block only includes a transaction whose signatures are valid. Note `slot` and `blockTime`. `maxSupportedTransactionVersion` is 1, as in the watchdog: with 0 the RPC refuses a version 1 transaction instead of returning it.

**For `missing`**, check the cluster and the program, not the canary. `getGenesisHash` must return `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` on devnet or `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` on mainnet, and `getAccountInfo` of the Bounty program must show it executable. Devnet can be reset, which removes the program and the canary. This is not an incident.

## 3. Act by status

**`drained`.** Send `check_honeypot` now. It is permissionless and costs only the fee: use the "Run watchdog check" button on /bounty with a wallet on that cluster, or from a checkout (after `npm ci` in `app/`):

```sh
cd app && CLUSTER=<cluster> WATCHDOG_KEYPAIR="$(cat <fee-only-key.json>)" node scripts/watchdog.mjs
```

`WATCHDOG_KEYPAIR` takes the key itself (a JSON array of 64 bytes), not a path. Use a key that only pays fees, never a deploy or upgrade-authority key; on devnet it can be left out, and the watchdog then asks for an airdrop, which is often rate limited. Then re-verify `tripped` on two sources as in step 2.

**`tripped`.** Nothing to send: the flag is permanent, and every vault on that cluster has its classical path closed on-chain. Vault users withdraw with post-quantum signatures (their recovery phrase), and should not move funds into Ed25519 wallets. The claimer field says how it tripped: all zero bytes for a honeypot drop, otherwise the address a bounty claim paid. The canary key is the same on every cluster, so read the other cluster's canary too, and send `check_honeypot` there if its honeypot dropped.

**`signed`, with the honeypot intact.** The program cannot take a signature as proof until Canary v2's `prove_signature`, so the flag stays untripped and programs that read it still see the canary as alive. Never say the flag tripped. Once the transaction is verified on two sources, publish it as the evidence. Vault users with wallet access on should turn it off with a post-quantum signature, since the flag does not close it this time.

**`history_gap`.** Page the canary key's full history for the window (the 48 hours before the alert run) with a keyed RPC or an explorer, and look for a transaction the key signed. The watchdog can do the read with a higher limit:

```sh
cd app && CLUSTER=<cluster> RPC_URL=<keyed RPC URL> HISTORY_LIMIT=<more than the window holds> LOOKBACK_HOURS=<48 plus the hours since the alert run> node scripts/watchdog.mjs
```

It reads about three transactions a second, prints `history=read X of Y transactions since <time>` and `signed_tx=`, and reports `history_gap` again if the limit was still too low. Run that way, it also sends `check_honeypot` if the honeypot moved, which is the same harmless call the scheduled run would make. If the key signed nothing, close the issue, recording the range you checked (the first and last signature, and their times). If it signed one, handle it as `signed`. Until then say nothing publicly. While the flood goes on, each run opens a new `history_gap` issue once the previous one is closed; check only the hours after the range already recorded.

**`missing`, or a failed run.** Operational only: fix the RPC endpoint, the fee payer (`WATCHDOG_KEYPAIR` or `WATCHDOG_MAINNET_KEYPAIR` and its balance) or the deployment, and say nothing publicly.

## 4. Communicate

Only after step 2, and only for `tripped` or `signed` (a `drained` canary becomes `tripped` once `check_honeypot` lands). Post the same text on X and the Telegram channel, and follow up in the same thread:

```text
Qanary canary (<cluster>): <what was observed>.
Transaction: <explorer link>, slot <slot>.
What it means: someone produced a valid signature for an Ed25519 key whose private key nobody knows. Treat Ed25519 keys as broken.
Qanary Vault users: move funds only with post-quantum signatures, and not into an Ed25519 wallet.<signed only: If wallet access is on, turn it off with a post-quantum signature.>
Record: <issue link>
```

What was observed:

- `tripped`: "the canary flag tripped, by a bounty claim" or "the canary flag tripped, after its honeypot fell below its baseline".
- `signed`: "the canary key signed a transaction. The program cannot record a signature as proof yet, so the on-chain flag is not tripped".

State only what was verified. Do not guess at the cause, name no other project, and mention no token.

## 5. Record

- Add to the issue, as comments: the verification links from both sources, the first-observation time (when the issue opened or the run started), and the trip slot or the signed transaction's slot with its time, so the detection latency shows.
- Until `prove_signature` exists, the issue is the only record of a `signed` finding: never delete it.
- Close the issue once it is handled. While it is open, the same status opens no other issue; a different status, such as `tripped` after `drained`, opens its own. A tripped canary stays tripped and every run reports it again, so leave the `tripped` issue open, or the next run opens another.

## 6. The bounty after a trip

A valid claim after a honeypot trip still pays the pool, by design: it is the same proof, and the pool goes to whoever proves the key. The first trip's record stays as it was: the slot and the claimer field do not change. Add the claim transaction to the `tripped` issue.
