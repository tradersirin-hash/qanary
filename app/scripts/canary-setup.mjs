// Sets up the canary on a cluster: initializes it and seeds the bounty pool and the honeypot, in one transaction.
// With --test-wallet (devnet only) it instead sends that wallet some devnet SOL.
//
//   node scripts/canary-setup.mjs --cluster devnet --keypair <payer.json> [--pool <lamports>] [--honeypot <lamports>]
//   node scripts/canary-setup.mjs --cluster mainnet --keypair <payer.json> [--pool <lamports>] [--honeypot <lamports>] [--yes]
//   node scripts/canary-setup.mjs --cluster devnet --keypair <payer.json> --test-wallet <address>
//
// --keypair is always required: the script never falls back to the Solana CLI keypair or config. --rpc overrides the
// cluster's public RPC. Pool and honeypot default to 0.3 SOL each; 0 skips that deposit.
// Devnet sends right away, as scripts/devnet-setup.mjs always did (--dry-run only prints). Mainnet is a dry run unless
// --yes: it prints every instruction, what each costs and the payer balance, and sends nothing. Before anything else it
// checks that the RPC serves the cluster named and that the bounty program is deployed there. It never initializes a
// canary twice: on devnet an existing canary only gets the deposits again, as before; on mainnet the script refuses,
// so a second run cannot send the deposits twice (top up a live canary from the Bounty page instead).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256 } from '@noble/hashes/sha2';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

const BOUNTY_PROGRAM = address('HhrtGaEUk6Tar4cdCHkgTZj7jY5YXha4wjfdm8EteXRV');
const CANARY_KEY = address('4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
// Canary: disc 8 | tripped 1 | tripped_slot 8 | claimer 32 | honeypot_baseline 8 | total_funded 8 | bump 1
const CANARY_SPACE = 66n;
const SEED_POOL = 300_000_000n; // 0.3 SOL
const SEED_HONEYPOT = 300_000_000n; // 0.3 SOL
const TEST_WALLET_SOL = 500_000_000n; // 0.5 SOL
const FEE_PER_SIGNATURE = 5_000n; // base fee; no priority fee is set
// The genesis hash proves the RPC serves the cluster named, so --cluster mainnet can never quietly hit devnet or back.
const CLUSTERS = {
  devnet: { rpc: 'https://api.devnet.solana.com', genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', explorer: '?cluster=devnet' },
  mainnet: { rpc: 'https://api.mainnet-beta.solana.com', genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', explorer: '' },
};
const USAGE =
  'usage: node scripts/canary-setup.mjs --cluster devnet|mainnet --keypair <payer.json> [--pool <lamports>] [--honeypot <lamports>] [--rpc <url>] [--yes | --dry-run] [--test-wallet <address>]';

const text = new TextEncoder();
const tag = (name) => sha256(text.encode(`global:${name}`)).slice(0, 8);
const u64le = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => `${lamports / 1_000_000_000n}.${(lamports % 1_000_000_000n).toString().padStart(9, '0')}`.replace(/\.?0+$/, '');
const show = (lamports) => `${lamports.toLocaleString('en-US')} lamports (${sol(lamports)} SOL)`;

class Refusal extends Error {}

function lamportsArg(name, value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Refusal(`--${name} takes a whole number of lamports, not "${value}"`);
  return BigInt(value);
}

export async function main(argv) {
  const { values: opts } = parseArgs({
    args: argv,
    options: {
      cluster: { type: 'string', default: 'devnet' },
      keypair: { type: 'string' },
      pool: { type: 'string' },
      honeypot: { type: 'string' },
      rpc: { type: 'string' },
      yes: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'test-wallet': { type: 'string' },
    },
  });
  const cluster = opts.cluster;
  if (!Object.hasOwn(CLUSTERS, cluster)) throw new Refusal(`--cluster must be devnet or mainnet, not "${cluster}"\n${USAGE}`);
  if (!opts.keypair) throw new Refusal(`--keypair <payer.json> is required: it pays and signs.\n${USAGE}`);
  const pool = lamportsArg('pool', opts.pool, SEED_POOL);
  const honeypot = lamportsArg('honeypot', opts.honeypot, SEED_HONEYPOT);
  // Mainnet moves real SOL only with --yes; devnet keeps its old behaviour of sending at once.
  const dryRun = opts['dry-run'] || (cluster === 'mainnet' && !opts.yes);

  const rpcUrl = opts.rpc || CLUSTERS[cluster].rpc;
  const rpc = createSolanaRpc(rpcUrl);
  const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(opts.keypair, 'utf8'))));
  const explorer = (path) => `https://explorer.solana.com/${path}${CLUSTERS[cluster].explorer}`;

  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== CLUSTERS[cluster].genesis) throw new Refusal(`${rpcUrl} does not serve ${cluster} (genesis hash ${genesis}).`);

  async function confirm(signature, lastValidBlockHeight) {
    for (;;) {
      const { value } = await rpc.getSignatureStatuses([signature]).send();
      const s = value[0];
      if (s?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(s.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return;
      if ((await rpc.getBlockHeight().send()) > lastValidBlockHeight) {
        throw new Error(`transaction ${signature} was not confirmed before its blockhash expired: check ${explorer(`tx/${signature}`)} before running again`);
      }
      await sleep(1000);
    }
  }

  async function send(label, instructions) {
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(tx);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64' }).send();
    await confirm(signature, blockhash.lastValidBlockHeight);
    console.log(`${label}: ${signature}\n${explorer(`tx/${signature}`)}`);
  }

  const funder = { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer };
  const { value: payerBalance } = await rpc.getBalance(payer.address).send();
  console.log(`cluster:  ${cluster} (${rpcUrl})`);
  console.log(`payer:    ${payer.address}, balance ${show(payerBalance)}`);

  if (opts['test-wallet']) {
    if (cluster !== 'devnet') throw new Refusal('--test-wallet is for devnet only.');
    const to = address(opts['test-wallet']);
    if (dryRun) return console.log(`DRY RUN: would send ${show(TEST_WALLET_SOL)} to ${to}. Nothing sent.`);
    await send(`send ${sol(TEST_WALLET_SOL)} SOL to test wallet`, [
      {
        programAddress: SYSTEM_PROGRAM,
        accounts: [funder, { address: to, role: AccountRole.WRITABLE }],
        data: concat(Uint8Array.of(2, 0, 0, 0), u64le(TEST_WALLET_SOL)),
      },
    ]);
    return;
  }

  const { value: program } = await rpc.getAccountInfo(BOUNTY_PROGRAM, { encoding: 'base64' }).send();
  if (!program?.executable) {
    throw new Refusal(`The bounty program ${BOUNTY_PROGRAM} is ${program ? 'not executable' : 'not deployed'} on ${cluster}. Deploy it first; nothing was sent.`);
  }
  console.log(`program:  ${BOUNTY_PROGRAM} (deployed, executable)`);

  const [canary] = await getProgramDerivedAddress({ programAddress: BOUNTY_PROGRAM, seeds: [text.encode('canary')] });
  const { value: existing } = await rpc.getAccountInfo(canary, { encoding: 'base64' }).send();
  // SOL that someone sent to the canary address first leaves a system account there; initialize takes it over.
  const initialized = !!existing && existing.owner !== SYSTEM_PROGRAM;
  if (initialized) {
    const data = Buffer.from(existing.data[0], 'base64');
    const valid = existing.owner === BOUNTY_PROGRAM && data.length >= Number(CANARY_SPACE);
    if (cluster !== 'devnet' || !valid) {
      throw new Refusal(
        `The canary ${canary} already exists on ${cluster} (owner ${existing.owner}, ${show(existing.lamports)}). ` +
          'Refusing to initialize it again; nothing was sent. Top up a live canary from the Bounty page instead.',
      );
    }
    if (data[8] === 1) throw new Refusal(`The canary ${canary} on ${cluster} has tripped and takes no more deposits; nothing was sent.`);
    if (pool === 0n && honeypot === 0n) throw new Refusal(`The canary ${canary} is already initialized and --pool and --honeypot are 0; nothing to send.`);
  }

  const prefunded = initialized ? 0n : (existing?.lamports ?? 0n);
  const [canaryRent, rentFloor, { value: honeypotBalance }] = await Promise.all([
    rpc.getMinimumBalanceForRentExemption(CANARY_SPACE).send(),
    rpc.getMinimumBalanceForRentExemption(0n).send(),
    rpc.getBalance(CANARY_KEY).send(),
  ]);
  // A transfer may not leave a new account below the rent-exempt minimum.
  if (honeypotBalance === 0n && honeypot > 0n && honeypot < rentFloor) {
    throw new Refusal(`The honeypot account does not exist yet, so --honeypot must be 0 or at least ${show(rentFloor)}.`);
  }
  const rentDue = initialized ? 0n : canaryRent > prefunded ? canaryRent - prefunded : 0n;
  if (initialized) console.log(`canary:   ${canary} (already initialized: initialize is skipped, only the deposits below are sent)`);
  else console.log(`canary:   ${canary} (not initialized${prefunded ? `; already holds ${show(prefunded)}, which counts toward its rent` : ''})`);
  console.log(`honeypot: ${CANARY_KEY}, balance ${show(honeypotBalance)}${honeypotBalance === 0n ? ' (account does not exist yet)' : ''}`);

  const instructions = [];
  const steps = [];
  if (!initialized) {
    instructions.push({
      programAddress: BOUNTY_PROGRAM,
      accounts: [funder, { address: canary, role: AccountRole.WRITABLE }, { address: CANARY_KEY, role: AccountRole.READONLY }, { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }],
      data: tag('initialize'),
    });
    steps.push(`initialize      creates the canary account: rent ${show(rentDue)}`);
  }
  if (pool > 0n) {
    instructions.push({
      programAddress: BOUNTY_PROGRAM,
      accounts: [funder, { address: canary, role: AccountRole.WRITABLE }, { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }],
      data: concat(tag('fund'), u64le(pool)),
    });
    steps.push(`fund            bounty pool: ${show(pool)}`);
  }
  if (honeypot > 0n) {
    instructions.push({
      programAddress: BOUNTY_PROGRAM,
      accounts: [funder, { address: CANARY_KEY, role: AccountRole.WRITABLE }, { address: canary, role: AccountRole.WRITABLE }, { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }],
      data: concat(tag('fund_honeypot'), u64le(honeypot)),
    });
    steps.push(`fund_honeypot   honeypot: ${show(honeypot)}`);
  }
  const fee = FEE_PER_SIGNATURE; // one transaction, signed by the payer only
  const total = rentDue + pool + honeypot + fee;

  console.log(`\n${dryRun ? 'Would send' : 'Sending'} one transaction to ${cluster}, paid and signed by ${payer.address}:`);
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log(`  network fee: ${show(fee)}`);
  console.log(`  total:       ${show(total)}`);
  console.log('This SOL does not come back: as deployed, only a valid signature by the canary key can move the pool or the honeypot.');
  // The payer must end at 0 or stay rent-exempt.
  const short = total > payerBalance || (payerBalance - total > 0n && payerBalance - total < rentFloor);
  if (total > payerBalance) console.log(`The payer balance is ${show(total - payerBalance)} short.`);
  else console.log(`Payer balance afterwards: ${show(payerBalance - total)}${short ? `, below the rent-exempt minimum of ${show(rentFloor)}` : ''}`);

  if (dryRun) {
    console.log(`\nDRY RUN: nothing sent.${cluster === 'mainnet' ? ' Run again with --yes to send it.' : ''}`);
    return;
  }
  if (short) throw new Refusal('Not enough SOL; nothing was sent.');
  await send(initialized ? 'fund bounty pool + honeypot' : 'initialize canary + fund bounty pool + honeypot', instructions);
}

/** Runs main(), printing a refusal (or a bad option) as a plain message with exit code 1. */
export async function cli(argv) {
  await main(argv).catch((e) => {
    if (!(e instanceof Refusal || e?.code?.startsWith('ERR_PARSE_ARGS'))) throw e;
    console.error(e.message);
    process.exitCode = 1;
  });
}

// Run directly, not imported by devnet-setup.mjs. Node resolves the entry's symlinks and junctions, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(process.argv.slice(2));
