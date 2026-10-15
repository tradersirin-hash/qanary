// Canary watchdog, run every 30 minutes by .github/workflows/watchdog.yml (and by hand: node scripts/watchdog.mjs).
//
// Reads the devnet canary and the honeypot balance. Lamports at the canary key can only go down if its
// private key signed, so a balance below the recorded baseline means someone broke the key: the watchdog
// then calls the permissionless `check_honeypot`, which trips the canary on-chain. Calling it when nothing
// dropped only refreshes the baseline, so a wrong guess is harmless.
//
// Fee payer: the WATCHDOG_KEYPAIR secret if set (a JSON array of 64 secret-key bytes, or 64 hex chars of a
// 32-byte seed); otherwise a throwaway key funded by a devnet airdrop at the moment it is needed.
// Writes status=alive|drained|tripped|missing (and details) to $GITHUB_OUTPUT for the workflow's alert step.
// A forced check that cannot send (say, a malformed WATCHDOG_KEYPAIR) fails the run; a real drop never does,
// so the alert step still opens the issue.
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

const [canary] = await getProgramDerivedAddress({ programAddress: BOUNTY_PROGRAM, seeds: [new TextEncoder().encode('canary')] });
const state = await readCanary(canary);
if (!state) {
  report({ status: 'missing', canary });
} else if (state.tripped) {
  report({ status: 'tripped', canary, balance: state.balance, baseline: state.baseline });
} else if (state.balance < state.baseline || process.env.FORCE_CHECK === '1') {
  // FORCE_CHECK=1 exercises the transaction path while nothing dropped: it only refreshes the baseline.
  const drained = state.balance < state.baseline;
  let tx = '';
  let payer = '';
  let error = '';
  try {
    ({ signature: tx, payer } = await checkHoneypot(canary));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const after = await readCanary(canary);
  report({
    status: after?.tripped ? 'tripped' : drained ? 'drained' : 'alive',
    tripped_now: !!after?.tripped,
    canary,
    balance: state.balance,
    baseline: state.baseline,
    tx,
    payer,
    error,
  });
  if (error && !drained) process.exitCode = 1;
} else {
  report({ status: 'alive', canary, balance: state.balance, baseline: state.baseline });
}
