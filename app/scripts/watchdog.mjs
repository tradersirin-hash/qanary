// Canary watchdog, scheduled twice an hour by .github/workflows/watchdog.yml (GitHub runs it a few times a day in
// practice) and runnable by hand: node scripts/watchdog.mjs.
//
// Reads the canary and the honeypot balance on CLUSTER (devnet, the default, or mainnet) through RPC_URL
// (default: the public RPC of that cluster; on devnet the older DEVNET_RPC is still read). Lamports at the
// canary key can only go down if its private key signed, so a balance below the recorded baseline means
// someone broke the key: the watchdog then calls the permissionless `check_honeypot`, which trips the canary
// on-chain. A balance above the baseline (a plain transfer to the canary key) gets the same call, which raises
// the baseline to the balance, so a key-breaker cannot take that surplus unnoticed. Calling it when nothing
// dropped only refreshes the baseline, so a wrong guess is harmless.
//
// A drop shows only while it lasts: a key-breaker could drain the honeypot and refill it between two runs, or
// sign without moving any SOL. So the watchdog also reads the newest HISTORY_LIMIT transactions (default 100)
// that mention the canary key, and reports any that the key signed: that is proof of a broken key even when the
// balance looks intact. The program cannot take a signature as proof yet, so this opens an issue but leaves the
// flag untripped. Each run reads only the newest ones, so a flood of more than HISTORY_LIMIT transactions
// between two runs could push a signed one out of view; a key that never signs on-chain stays invisible.
//
// Fee payer, needed only to send: the WATCHDOG_KEYPAIR secret if set (a JSON array of 64 secret-key bytes, or
// 64 hex chars of a 32-byte seed); otherwise, on devnet, a throwaway key funded by an airdrop at the moment it
// is needed. Mainnet has no airdrop, so without a key the watchdog still reads and reports, and only a send fails.
// Writes cluster=… and status=alive|drained|signed|tripped|missing (and details) to $GITHUB_OUTPUT for the
// workflow's alert step. A send that fails while nothing is wrong (a forced check, or raising the baseline, say
// with a malformed WATCHDOG_KEYPAIR) fails the run; a real drop or a signature never does, so the alert step
// still opens the issue.
import { appendFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { failsRun, findSignature, historyNote, honeypotCheck, watchStatus } from './watchdog-logic.mjs';

const BOUNTY_PROGRAM = address('HhrtGaEUk6Tar4cdCHkgTZj7jY5YXha4wjfdm8EteXRV');
const CANARY_KEY = address('4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ');
// The genesis hash proves RPC_URL serves the cluster named, so a misconfigured endpoint cannot report another cluster's canary.
const CLUSTERS = {
  devnet: { rpc: 'https://api.devnet.solana.com', genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', airdrop: true },
  mainnet: { rpc: 'https://api.mainnet-beta.solana.com', genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', airdrop: false },
};
const cluster = process.env.CLUSTER || 'devnet';
if (!Object.hasOwn(CLUSTERS, cluster)) throw new Error(`CLUSTER must be devnet or mainnet, not "${cluster}"`);
const rpc = createSolanaRpc(process.env.RPC_URL || (cluster === 'devnet' && process.env.DEVNET_RPC) || CLUSTERS[cluster].rpc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How many of the newest transactions that mention the canary key each run reads: one getSignaturesForAddress call
// per 1000, then one getTransaction each.
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 100);
if (!Number.isInteger(HISTORY_LIMIT) || HISTORY_LIMIT < 1) throw new Error(`HISTORY_LIMIT must be a whole number above 0, not "${process.env.HISTORY_LIMIT}"`);

function report(fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

/** Canary account: disc 8 | tripped 1 | tripped_slot 8 | claimer 32 | honeypot_baseline 8 | total_funded 8 | bump 1. */
async function readCanary(canary) {
  const [{ value: account }, { value: balance }] = await Promise.all([
    rpc.getAccountInfo(canary, { encoding: 'base64', commitment: 'confirmed' }).send(),
    rpc.getBalance(CANARY_KEY, { commitment: 'confirmed' }).send(),
  ]);
  if (!account || account.owner !== BOUNTY_PROGRAM) return null;
  const d = Buffer.from(account.data[0], 'base64');
  if (d.length < 66) return null;
  return { tripped: d[8] === 1, baseline: d.readBigUInt64LE(49), balance };
}

async function confirm(signature) {
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const s = value[0];
    if (s?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return;
    await sleep(1000);
  }
  throw new Error(`transaction ${signature} not confirmed in time`);
}

async function feePayer() {
  const secret = process.env.WATCHDOG_KEYPAIR?.trim();
  if (secret) {
    if (/^[0-9a-f]{64}$/i.test(secret)) return createKeyPairSignerFromPrivateKeyBytes(Buffer.from(secret, 'hex'));
    if (/^\[[\d,\s]+\]$/.test(secret)) return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(secret)));
    throw new Error('WATCHDOG_KEYPAIR is neither 64 hex characters nor a JSON array of 64 bytes');
  }
  if (!CLUSTERS[cluster].airdrop) throw new Error(`no WATCHDOG_KEYPAIR, and ${cluster} has no airdrop to pay the fee`);
  const signer = await generateKeyPairSigner();
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await confirm(await rpc.requestAirdrop(signer.address, lamports(10_000_000n)).send());
      return signer;
    } catch (e) {
      lastError = e;
      await sleep(5000 * (attempt + 1));
    }
  }
  throw new Error(`no WATCHDOG_KEYPAIR and the ${cluster} airdrop failed: ${lastError?.message ?? lastError}`);
}

async function checkHoneypot(canary) {
  const signer = await feePayer();
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const instruction = {
    programAddress: BOUNTY_PROGRAM,
    accounts: [
      { address: CANARY_KEY, role: AccountRole.READONLY },
      { address: canary, role: AccountRole.WRITABLE },
    ],
    data: sha256(new TextEncoder().encode('global:check_honeypot')).slice(0, 8),
  };
  const tx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions([instruction], m),
    ),
  );
  const signature = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64' }).send();
  await confirm(signature);
  return { signature, payer: signer.address };
}

/** The first transaction the canary key signed, if any, among the newest HISTORY_LIMIT that mention it. Reads are
 *  paced to stay under the public RPCs' per-method limit (about 4 calls a second). */
async function signedHistory() {
  return findSignature({
    key: CANARY_KEY,
    limit: HISTORY_LIMIT,
    page: (before, limit) => rpc.getSignaturesForAddress(CANARY_KEY, { before, limit, commitment: 'confirmed' }).send(),
    read: async (signature) => {
      await sleep(300);
      return rpc.getTransaction(signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).send();
    },
  });
}

const genesis = await rpc.getGenesisHash().send();
if (genesis !== CLUSTERS[cluster].genesis) throw new Error(`RPC_URL does not serve ${cluster} (genesis hash ${genesis})`);
const [canary] = await getProgramDerivedAddress({ programAddress: BOUNTY_PROGRAM, seeds: [new TextEncoder().encode('canary')] });
const state = await readCanary(canary);
if (!state) {
  report({ cluster, status: 'missing', canary });
} else if (state.tripped) {
  report({ cluster, status: 'tripped', canary, balance: state.balance, baseline: state.baseline });
} else {
  let signedTx = '';
  let history;
  try {
    const found = await signedHistory();
    signedTx = found.signed ?? '';
    history = historyNote(found);
  } catch (e) {
    // The balance check below still runs: an unreadable history is reported, not fatal.
    history = `not read: ${e instanceof Error ? e.message : String(e)}`;
  }
  // FORCE_CHECK=1 exercises the transaction path while nothing changed: it only refreshes the baseline.
  const check = honeypotCheck(state, process.env.FORCE_CHECK === '1');
  let after = state;
  let tx = '';
  let payer = '';
  let error = '';
  if (check) {
    try {
      ({ signature: tx, payer } = await checkHoneypot(canary));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    after = await readCanary(canary);
  }
  const status = watchStatus({ tripped: !!after?.tripped, check, signed: !!signedTx });
  report({
    cluster,
    status,
    tripped_now: !!after?.tripped,
    canary,
    balance: state.balance,
    baseline: state.baseline,
    check: check ?? '',
    tx,
    payer,
    error,
    signed_tx: signedTx,
    history,
  });
  if (failsRun({ status, error })) process.exitCode = 1;
}
