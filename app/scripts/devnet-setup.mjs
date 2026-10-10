// One-time devnet setup: initialize the canary and seed the bounty pool and honeypot.
// With a test wallet address, it only sends that wallet some devnet SOL.
//
//   node scripts/devnet-setup.mjs <deployer-keypair.json>
//   node scripts/devnet-setup.mjs <deployer-keypair.json> <test-wallet-address>
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  devnet,
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
const SEED_POOL = 300_000_000n; // 0.3 SOL
const SEED_HONEYPOT = 300_000_000n; // 0.3 SOL
const TEST_WALLET_SOL = 500_000_000n; // 0.5 SOL

const rpc = createSolanaRpc(devnet('https://api.devnet.solana.com'));
const text = new TextEncoder();
const tag = (name) => sha256(text.encode(`global:${name}`)).slice(0, 8);
const u64le = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));

const [keyPath, testWallet] = process.argv.slice(2);
if (!keyPath) throw new Error('usage: node scripts/devnet-setup.mjs <deployer-keypair.json> [test-wallet-address]');
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))));
const [canary] = await getProgramDerivedAddress({ programAddress: BOUNTY_PROGRAM, seeds: [text.encode('canary')] });

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
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`${label} failed: ${JSON.stringify(value[0].err)}`);
    if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') {
      console.log(`${label}: ${signature}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label}: not confirmed in time (${signature})`);
}

const funder = { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer };

if (testWallet) {
  await send(`send ${Number(TEST_WALLET_SOL) / 1e9} SOL to test wallet`, [
    {
      programAddress: SYSTEM_PROGRAM,
      accounts: [funder, { address: address(testWallet), role: AccountRole.WRITABLE }],
      data: concat(Uint8Array.of(2, 0, 0, 0), u64le(TEST_WALLET_SOL)),
    },
  ]);
  process.exit(0);
}

const existing = await rpc.getAccountInfo(canary, { encoding: 'base64' }).send();
if (!existing.value) {
  await send('initialize canary', [
    {
      programAddress: BOUNTY_PROGRAM,
      accounts: [funder, { address: canary, role: AccountRole.WRITABLE }, { address: CANARY_KEY, role: AccountRole.READONLY }, { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }],
      data: tag('initialize'),
    },
  ]);
} else {
  console.log('canary already initialized');
}

await send('fund bounty pool + honeypot', [
  {
    programAddress: BOUNTY_PROGRAM,
    accounts: [funder, { address: canary, role: AccountRole.WRITABLE }, { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }],
    data: concat(tag('fund'), u64le(SEED_POOL)),
  },
  {
    programAddress: BOUNTY_PROGRAM,
    accounts: [funder, { address: CANARY_KEY, role: AccountRole.WRITABLE }, { address: canary, role: AccountRole.WRITABLE }, { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }],
    data: concat(tag('fund_honeypot'), u64le(SEED_HONEYPOT)),
  },
]);
