// Canary watchdog, scheduled twice an hour by .github/workflows/watchdog.yml (GitHub runs it a few times a day in
// practice) and runnable by hand: node scripts/watchdog.mjs.
//
// Reads the devnet canary and the honeypot balance. Lamports at the canary key can only go down if its
// private key signed, so a balance below the recorded baseline means someone broke the key: the watchdog
// then calls the permissionless `check_honeypot`, which trips the canary on-chain. A balance above the baseline
// (a plain transfer to the canary key) gets the same call, which raises the baseline to the balance, so a
// key-breaker cannot take that surplus unnoticed. Calling it when nothing dropped only refreshes the baseline,
// so a wrong guess is harmless.
//
// A drop shows only while it lasts: a key-breaker could drain the honeypot and refill it between two runs, or
// sign without moving any SOL. So the watchdog also reads the newest HISTORY_LIMIT transactions (default 100)
// that mention the canary key, and reports any that the key signed: that is proof of a broken key even when the
// balance looks intact. The program cannot take a signature as proof yet, so this opens an issue but leaves the
// flag untripped. Each run reads only the newest ones, so a flood of more than HISTORY_LIMIT transactions
// between two runs could push a signed one out of view; a key that never signs on-chain stays invisible.
//
// Fee payer, needed only to send: the WATCHDOG_KEYPAIR secret if set (a JSON array of 64 secret-key bytes, or
// 64 hex chars of a 32-byte seed); otherwise a throwaway key funded by a devnet airdrop at the moment it is needed.
// Writes status=alive|drained|signed|tripped|missing (and details) to $GITHUB_OUTPUT for the workflow's alert
// step. A send that fails while nothing is wrong (a forced check, or raising the baseline, say with a malformed
// WATCHDOG_KEYPAIR) fails the run, and so does a history that could not be read, so neither passes for alive; a
// real drop or a signature never does, so the alert step still opens the issue.
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
  devnet,
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

const BOUNTY_PROGRAM = address('HhrtGaEUk6Tar4cdCHkgTZj7jY5YXha4wjfdm8EteXRV');
const CANARY_KEY = address('4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ');
const rpc = createSolanaRpc(devnet(process.env.DEVNET_RPC || 'https://api.devnet.solana.com'));
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

/** Why the watchdog sends check_honeypot to a canary that is not tripped, or null when it has no reason to.
 *  - 'drop': the honeypot fell below its baseline. Only the canary key can cause that, so the program trips the canary.
 *  - 'surplus': the honeypot holds more than its baseline (a plain transfer, not fund_honeypot). The program raises the
 *    baseline to the balance; otherwise a key-breaker could take the surplus back down to the old baseline unnoticed.
 *  - 'forced': FORCE_CHECK with nothing to fix. It only tests the fee payer.
 *  A wrong guess is harmless: the program trips only on a real drop, and otherwise just records the balance. */
function honeypotCheck({ balance, baseline }, force = false) {
  if (balance < baseline) return 'drop';
  if (balance > baseline) return 'surplus';
  return force ? 'forced' : null;
}

/** True if `key` signed the transaction (a getTransaction response with encoding 'json'). The signers are the first
 *  header.numRequiredSignatures static account keys; an address lookup table can never supply a signer. */
function signedBy(transaction, key) {
  const { header, accountKeys } = transaction.transaction.message;
  return accountKeys.slice(0, Number(header.numRequiredSignatures)).includes(key);
}

/** Reads the transactions that mention `key`, newest first, at most `limit` of them, and stops at the first one `key`
 *  signed. Failed transactions count: a block only includes a transaction whose signatures are valid.
 *  `page(before, limit)` is getSignaturesForAddress (newest first, at most 1000 a call); `read(signature)` is
 *  getTransaction, which returns null while the node cannot serve that transaction yet. */
async function findSignature({ key, limit, page, read }) {
  let before;
  let listed = 0;
  let checked = 0;
  let complete = false;
  while (listed < limit && !complete) {
    const want = Math.min(1000, limit - listed);
    const signatures = await page(before, want);
    listed += signatures.length;
    // A short page means the history ends here.
    complete = signatures.length < want;
    for (const { signature } of signatures) {
      const transaction = await read(signature);
      if (!transaction) continue;
      checked++;
      if (signedBy(transaction, key)) return { signed: signature, listed, checked, complete };
    }
    before = signatures.at(-1)?.signature;
  }
  return { signed: null, listed, checked, complete };
}

/** One line for the report on how much of the canary key's history this run read. */
function historyNote({ listed, checked, complete }) {
  return `read ${checked} of ${listed} transactions, ${complete ? 'the whole history' : 'the newest only'}`;
}

/** The status the alert step switches on, the most serious first:
 *  - 'tripped': the flag is set on-chain.
 *  - 'drained': the honeypot dropped, but the watchdog could not trip the canary.
 *  - 'signed': the canary key signed a transaction, though the honeypot balance does not show it (say, it was
 *    refilled). The program cannot take a signature as proof yet, so the flag stays untripped.
 *  - 'alive': none of these. */
function watchStatus({ tripped, check, signed }) {
  if (tripped) return 'tripped';
  if (check === 'drop') return 'drained';
  if (signed) return 'signed';
  return 'alive';
}

/** A failed send (a forced check, or raising the baseline) or an unreadable history fails the run only while nothing
 *  is wrong, so the owner hears about a broken fee payer or RPC instead of a run that passes for alive. When an alert
 *  is due the run never fails, so the alert step still runs. */
const failsRun = ({ status, error, historyError }) => status === 'alive' && (!!error || !!historyError);

/** Canary account: disc 8 | tripped 1 | tripped_slot 8 | claimer 32 | honeypot_baseline 8 | total_funded 8 | bump 1.
 *  Read in one call with the honeypot, so the baseline and the balance come from the same slot: two calls could
 *  straddle a fund_honeypot and report a drop that never happened. */
async function readCanary(canary) {
  const {
    value: [account, honeypot],
  } = await rpc.getMultipleAccounts([canary, CANARY_KEY], { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!account || account.owner !== BOUNTY_PROGRAM) return null;
  const d = Buffer.from(account.data[0], 'base64');
  if (d.length < 66) return null;
  return { tripped: d[8] === 1, baseline: d.readBigUInt64LE(49), balance: honeypot?.lamports ?? 0n };
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
  throw new Error(`no WATCHDOG_KEYPAIR and the devnet airdrop failed: ${lastError?.message ?? lastError}`);
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

/** Sends an RPC request, and once more after a pause if it fails: the public RPCs answer a burst with 429. */
const retryOnce = (send) => send().catch(() => sleep(2000).then(send));

/** The first transaction the canary key signed, if any, among the newest HISTORY_LIMIT that mention it. Reads are
 *  paced to stay under the public RPCs' per-method limit (about 4 calls a second). */
async function signedHistory() {
  return findSignature({
    key: CANARY_KEY,
    limit: HISTORY_LIMIT,
    page: (before, limit) => retryOnce(() => rpc.getSignaturesForAddress(CANARY_KEY, { before, limit, commitment: 'confirmed' }).send()),
    read: async (signature) => {
      await sleep(300);
      return retryOnce(() =>
        rpc.getTransaction(signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).send(),
      );
    },
  });
}

const [canary] = await getProgramDerivedAddress({ programAddress: BOUNTY_PROGRAM, seeds: [new TextEncoder().encode('canary')] });
const state = await readCanary(canary);
if (!state) {
  report({ status: 'missing', canary });
} else if (state.tripped) {
  report({ status: 'tripped', canary, balance: state.balance, baseline: state.baseline });
} else {
  // FORCE_CHECK=1 exercises the transaction path while nothing changed: it only refreshes the baseline.
  const check = honeypotCheck(state, process.env.FORCE_CHECK === '1');
  let after = state;
  let tx = '';
  let payer = '';
  let error = '';
  // The check goes first: reading the history takes a while, and a drop should trip the canary without waiting for it.
  if (check) {
    try {
      ({ signature: tx, payer } = await checkHoneypot(canary));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    after = await readCanary(canary);
  }
  let signedTx = '';
  let history;
  let historyError = '';
  try {
    const found = await signedHistory();
    signedTx = found.signed ?? '';
    history = historyNote(found);
  } catch (e) {
    historyError = e instanceof Error ? e.message : String(e);
    history = `not read: ${historyError}`;
  }
  const status = watchStatus({ tripped: !!after?.tripped, check, signed: !!signedTx });
  report({
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
  if (failsRun({ status, error, historyError })) process.exitCode = 1;
}
