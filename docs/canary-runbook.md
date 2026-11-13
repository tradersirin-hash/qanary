# Canary incident runbook

What to do when the canary watchdog, the site or a report says something happened to the canary. The watchdog's alert issues are public the moment they open, so the first rule is: **verify on two independent sources before any public statement**, and until then add facts to the issue only.

This runbook matches the watchdog on this branch, which watches the devnet canary only. The canary is the Qanary Bounty program's account `DDNM18i4XcRS2n2Uwh8BaYQcJhJZBz4hRjK4pyZbbq1Q`. Its honeypot is the plain SOL at the canary key `4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ`, which only a signature by that key can move.

## 1. What can fire

- **A watchdog issue**, labelled `canary` and titled `Canary watchdog: <status>`:
  - `tripped`: the flag is set on-chain.
  - `drained`: the honeypot fell below its baseline, but the watchdog could not send `check_honeypot` to trip the canary. The issue gives the error.
  - `signed`: the canary key signed one of the transactions the watchdog read, while the honeypot is not below its baseline. Each run reads the newest `HISTORY_LIMIT` transactions that mention the key (100 by default), and the issue says whether that was the whole history or the newest only.
  - `missing`: the canary account could not be read.
- **A failed run** of the Canary watchdog workflow: a fee payer that could not send a forced check or a baseline raise, or a history that could not be read. It opens no issue, so it shows only in the Actions tab and GitHub's failed-run notifications. When the step that failed is "Open an alert issue", an alert was due but GitHub did not take the issue: the `status=` line of the step before it names the alert, so handle it as that status.
- **The red state on /bounty and in the home stats strip.** The site reads the canary live, and shows red only when the flag is tripped. It does not compare the honeypot with its baseline yet, so a drained honeypot still shows Alive until `check_honeypot` trips the flag.
- **An outside report** through [SECURITY.md](../SECURITY.md). Keep it private as that policy says, and verify it with the steps below like any alert.

**While any `canary` issue is open, the watchdog opens no other.** A later status, such as `tripped` after `drained` or `signed`, then shows only in the run logs (the `status=` line of the watchdog step). So close an issue as soon as it is handled, and while one is open, read the latest run's log before acting.

## 2. Verify first

Use two independent sources: the devnet public RPC and a keyed RPC from another provider, or one RPC and a block explorer. Read at commitment `finalized`, so the result cannot roll back; a fresh event finalizes about 15 seconds after it lands.

**The flag and the honeypot.** Read the canary (the Canary line of the issue, or `canary=` in the run log) and the honeypot in one `getMultipleAccounts` call, so both come from the same slot:

```sh
RPC=https://api.devnet.solana.com   # then repeat with the second source
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

**For `missing`**, check the cluster and the program, not the canary. `getGenesisHash` must return `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (devnet), and `getAccountInfo` of the Bounty program must show it executable. Devnet can be reset, which removes the program and the canary. This is not an incident.

## 3. Act by status

**`drained`.** Send `check_honeypot` now. It is permissionless and costs only the fee: use the "Run watchdog check" button on /bounty with a devnet wallet, or from a checkout (after `npm ci` in `app/`):

```sh
cd app && WATCHDOG_KEYPAIR="$(cat <fee-only-key.json>)" node scripts/watchdog.mjs
```

`WATCHDOG_KEYPAIR` takes the key itself (a JSON array of 64 bytes), not a path. Use a key that only pays fees, never a deploy or upgrade-authority key. It can be left out: the watchdog then asks for a devnet airdrop, which is often rate limited. `DEVNET_RPC` sets another devnet RPC. Then re-verify `tripped` on two sources as in step 2.

**`tripped`.** Nothing to send: the flag is permanent, and every devnet vault has its classical path closed on-chain. Vault users withdraw with post-quantum signatures (their recovery phrase), and should not move funds into Ed25519 wallets. The claimer field says how it tripped: all zero bytes for a honeypot drop, otherwise the address a bounty claim paid.

**`signed`, with the honeypot intact.** The program cannot take a signature as proof yet, so the flag stays untripped and programs that read it still see the canary as alive. Never say the flag tripped. Once the transaction is verified on two sources, publish it as the evidence. Vault users with wallet access on should turn it off with a post-quantum signature, since the flag does not close it this time.

When an issue says the history read was "the newest only", a flood of more than `HISTORY_LIMIT` transactions could have pushed an older signed one out of view. To read further back, run the watchdog with a keyed RPC and a higher limit; it reads about three transactions a second, and stops at the first one the key signed:

```sh
cd app && DEVNET_RPC=<keyed devnet RPC URL> HISTORY_LIMIT=<number of transactions to read> node scripts/watchdog.mjs
```

Run that way, it also sends `check_honeypot` if the honeypot moved, which is the same harmless call the scheduled run would make.

**`missing`, or a failed run.** Operational only: fix the RPC endpoint, the fee payer (`WATCHDOG_KEYPAIR` and its balance) or the deployment, and say nothing publicly. A failed "Open an alert issue" step is the exception: an alert was due, so handle it under its status above (section 1 says where to read it).

## 4. Communicate

Only after step 2, and only for `tripped` or `signed` (a `drained` canary becomes `tripped` once `check_honeypot` lands). Post the same text on X and the Telegram channel, and follow up in the same thread:

```text
Qanary canary (devnet): <what was observed>.
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
- The issue is the only record of a `signed` finding: never delete it.
- Close the issue once it is handled, since an open one holds back every other alert (section 1). The exception is `tripped`: the flag is permanent and every run reports it again, so leave that issue open as the standing record.

## 6. The bounty after a trip

A valid claim after a honeypot trip still pays the pool, by design: it is the same proof, and the pool goes to whoever proves the key. The first trip's record stays as it was: the slot and the claimer field do not change. Add the claim transaction to the `tripped` issue.
