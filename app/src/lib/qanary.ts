// Client for the Qanary Vault and Qanary Bounty programs, each on its configured cluster: PDAs, account
// decoding, instruction encoding (Anchor layout), request validation and wallet-signed sends.
import { sha256 } from '@noble/hashes/sha2';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getProgramDerivedAddress,
  getTransactionEncoder,
  isAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type Signature,
} from '@solana/kit';
import { t, tOn } from '../copy';
import type { Cluster } from './cluster';
import { BOUNTY_PROGRAM_ID, CANARY_CLUSTER, CANARY_KEY_ID, NETWORKS, VAULT_CLUSTER, VAULT_PROGRAM_ID } from './constants';
import { UserFacingError } from './errors';
import * as lmots from './lmots';
import { signAndSend, type StandardWallet, type WalletAccount } from './wallet';

const connect = (url: string) => createSolanaRpc(url);
const clients = new Map<Cluster, ReturnType<typeof connect>>();
/** One RPC client per cluster, so the vault and the canary share it when they run on the same cluster. */
export function rpc(cluster: Cluster) {
  let client = clients.get(cluster);
  if (!client) clients.set(cluster, (client = connect(NETWORKS[cluster].rpc)));
  return client;
}

export const VAULT_PROGRAM = address(VAULT_PROGRAM_ID);
export const BOUNTY_PROGRAM = address(BOUNTY_PROGRAM_ID);
export const CANARY_KEY = address(CANARY_KEY_ID);
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const COMPUTE_BUDGET = address('ComputeBudget111111111111111111111111111111');
export const PQ_COMPUTE_UNITS = 1_400_000;

// Vault: disc 8 | id 16 | genesis_key 24 | key 24 | nonce u32 | owner Option<Pubkey> | bump
const VAULT_SPACE = 8 + 16 + 24 + 24 + 4 + 33 + 1;
// Canary: disc 8 | tripped 1 | tripped_slot 8 | claimer 32 | honeypot_baseline 8 | total_funded 8 | bump 1
const CANARY_SPACE = 8 + 1 + 8 + 32 + 8 + 8 + 1;
const MESSAGE_DOMAIN = 'qanary-vault-v1';
const U64_MAX = 0xffff_ffff_ffff_ffffn;

const text = new TextEncoder();
const addrEnc = getAddressEncoder();
const addrDec = getAddressDecoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
const bytes = (a: Address) => new Uint8Array(addrEnc.encode(a));
const u32le = (v: number) => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
const u32be = (v: number) => Uint8Array.of(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > U64_MAX) throw new RangeError(`Amount out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
const option = (a: Address | null) => (a ? concat(Uint8Array.of(1), bytes(a)) : Uint8Array.of(0));
/** Anchor instruction discriminator. */
const ixTag = (name: string) => sha256(text.encode(`global:${name}`)).slice(0, 8);
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

/** Exact decimal SOL string to lamports (no float math): "0.5", "0,5" and ".5" all work. Returns null unless it is
 *  a positive amount with at most 9 decimals (no sign, no thousands separators). */
export function parseSol(input: string): bigint | null {
  const s = input.trim();
  // "1,000" may mean one thousand or one, so it is refused rather than guessed.
  if (/^[1-9]\d{0,2},\d{3}$/.test(s)) return null;
  const m = s.match(/^(\d*)(?:[.,](\d{1,9}))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const lamports = BigInt(m[1] || '0') * 1_000_000_000n + BigInt((m[2] ?? '').padEnd(9, '0'));
  return lamports > 0n && lamports <= U64_MAX ? lamports : null;
}

// ---------- keys ----------

export type VaultKeys = { id: Uint8Array; seed: Uint8Array; genesisKey: Uint8Array };

const normalize = (phrase: string) => phrase.trim().toLowerCase().split(/\s+/).join(' ');
export const isValidPhrase = (phrase: string) => validateMnemonic(normalize(phrase), wordlist);

/** Suffix of the derivation tags per cluster. One phrase must never sign with the same one-time key on
 *  two clusters: a second signature by an LM-OTS key lets anyone forge with it. Devnet keeps the
 *  original, unsuffixed tags so existing devnet vaults still open from the same phrase. */
const CLUSTER_TAG: Record<Cluster, string> = { devnet: '', mainnet: '/mainnet' };

/** The 24-word phrase is the only secret: it yields the vault id, the LM-OTS seed and so every key. */
export function deriveKeys(phrase: string, cluster: Cluster = VAULT_CLUSTER): VaultKeys {
  const master = mnemonicToSeedSync(normalize(phrase));
  const tag = CLUSTER_TAG[cluster];
  const id = sha256(concat(text.encode(`qanary/vault-id/v1${tag}`), master)).slice(0, lmots.ID_LEN);
  const seed = sha256(concat(text.encode(`qanary/lmots-seed/v1${tag}`), master)).slice(0, lmots.N);
  return { id, seed, genesisKey: lmots.publicKey(id, 0, seed) };
}

/** The address commits to the id and to key 0, so nobody can attach another key chain to it. */
export async function vaultAddress(keys: Pick<VaultKeys, 'id' | 'genesisKey'>): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: VAULT_PROGRAM, seeds: [text.encode('vault'), keys.id, keys.genesisKey] });
  return pda;
}

export async function canaryAddress(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: BOUNTY_PROGRAM, seeds: [text.encode('canary')] });
  return pda;
}

// ---------- accounts ----------

function b64(data: string): Uint8Array {
  const bin = atob(data);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function readAccount(cluster: Cluster, a: Address) {
  const { value } = await rpc(cluster).getAccountInfo(a, { encoding: 'base64' }).send();
  return value
    ? { owner: value.owner as string, lamports: value.lamports as bigint, executable: value.executable, data: b64(value.data[0]) }
    : null;
}

export type VaultState = {
  address: Address;
  id: Uint8Array;
  genesisKey: Uint8Array;
  key: Uint8Array;
  nonce: number;
  owner: Address | null;
  lamports: bigint;
  spendable: bigint;
};

export async function fetchVault(a: Address): Promise<VaultState | null> {
  const account = await readAccount(VAULT_CLUSTER, a);
  // Exactly the vault layout: anything else owned by the program (or a future layout) is not read as a vault.
  if (!account || account.owner !== VAULT_PROGRAM || account.data.length !== VAULT_SPACE) return null;
  const d = account.data;
  const nonce = new DataView(d.buffer, d.byteOffset).getUint32(72, true);
  const owner = d[76] === 1 ? addrDec.decode(d.slice(77, 109)) : null;
  const rent = await rpc(VAULT_CLUSTER).getMinimumBalanceForRentExemption(BigInt(VAULT_SPACE)).send();
  const spendable = account.lamports > rent ? account.lamports - rent : 0n;
  return { address: a, id: d.slice(8, 24), genesisKey: d.slice(24, 48), key: d.slice(48, 72), nonce, owner, lamports: account.lamports, spendable };
}

export type CanaryState = {
  address: Address;
  tripped: boolean;
  /** The slot of the first trip; 0 while not tripped. */
  trippedSlot: bigint;
  /** The first claim's recipient, set only when a claim tripped the canary first; null otherwise. */
  claimer: Address | null;
  honeypotBaseline: bigint;
  honeypotLamports: bigint;
  totalFunded: bigint;
  pool: bigint;
};

/** The canary on `cluster`: the bounty's own, or the one a vault program checks on its cluster. The canary account
 *  and the honeypot are read in one call, so the baseline and the balance come from the same slot: two calls could
 *  straddle a fund_honeypot and show a drop that never happened. */
export async function fetchCanary(cluster: Cluster = CANARY_CLUSTER): Promise<CanaryState | null> {
  const a = await canaryAddress();
  const [{ value }, rent] = await Promise.all([
    rpc(cluster).getMultipleAccounts([a, CANARY_KEY], { encoding: 'base64' }).send(),
    rpc(cluster).getMinimumBalanceForRentExemption(BigInt(CANARY_SPACE)).send(),
  ]);
  // A reply missing an entry is malformed: reading the absent honeypot as 0 would show a drain that never happened.
  if (value.length !== 2) throw new Error('The RPC returned an incomplete canary read.');
  const [account, honeypot] = value;
  if (!account || account.owner !== BOUNTY_PROGRAM) return null;
  const d = b64(account.data[0]);
  if (d.length < 66) return null;
  const view = new DataView(d.buffer, d.byteOffset);
  const claimer = addrDec.decode(d.slice(17, 49));
  return {
    address: a,
    tripped: d[8] === 1,
    trippedSlot: view.getBigUint64(9, true),
    claimer: claimer === SYSTEM_PROGRAM ? null : claimer,
    honeypotBaseline: view.getBigUint64(49, true),
    // No account at the canary key holds no lamports.
    honeypotLamports: honeypot ? (honeypot.lamports as bigint) : 0n,
    totalFunded: view.getBigUint64(57, true),
    pool: account.lamports > rent ? account.lamports - rent : 0n,
  };
}

/** True once the bounty program is deployed on `cluster` (its canary may still need initializing). */
export async function bountyDeployed(cluster: Cluster = CANARY_CLUSTER): Promise<boolean> {
  const account = await readAccount(cluster, BOUNTY_PROGRAM);
  return account?.executable === true;
}

// ---------- request validation (before any one-time key signs) ----------

/** Keys the runtime never write-locks (agave-reserved-account-keys). Mirrors `RESERVED_KEYS` in the vault
 *  program, which skips them; qanary.test.ts checks the two lists match. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'AddressLookupTab1e1111111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'Config1111111111111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
  'Feature111111111111111111111111111111111111',
  'LoaderV411111111111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111',
  'StakeConfig11111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  '11111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'ZkE1Gama1Proof11111111111111111111111111111',
  'ZkTokenProof1111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarEpochRewards1111111111111111111111111',
  'SysvarEpochSchedu1e111111111111111111111111',
  'SysvarFees111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
  'SysvarLastRestartS1ot1111111111111111111111',
  'SysvarRecentB1ockHashes11111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'SysvarRewards111111111111111111111111111111',
  'SysvarS1otHashes111111111111111111111111111',
  'SysvarS1otHistory11111111111111111111111111',
  'SysvarStakeHistory1111111111111111111111111',
  'NativeLoader1111111111111111111111111111111',
  'Sysvar1111111111111111111111111111111111111',
]);

/** 0.01 SOL left in the wallet by a deposit, Max included, so it can still pay rent and later withdrawal fees. */
export const DEPOSIT_RESERVE = 10_000_000n;

/** The most `owner` can deposit: its confirmed balance minus DEPOSIT_RESERVE. */
export async function maxDeposit(owner: Address): Promise<bigint> {
  const { value } = await rpc(VAULT_CLUSTER).getBalance(owner, { commitment: 'confirmed' }).send();
  const balance = value as bigint;
  return balance > DEPOSIT_RESERVE ? balance - DEPOSIT_RESERVE : 0n;
}

export type WithdrawCheck = { ok: true; lamports: bigint; destination: Address } | { ok: false; reason: 'amount' | 'balance' | 'destination' | 'rent' };

/** Rejects requests the program would not execute, so a one-time key is never spent on them. */
export async function checkWithdraw(vault: VaultState, amountInput: string, destinationInput: string): Promise<WithdrawCheck> {
  const lamports = parseSol(amountInput);
  if (lamports === null || lamports === 0n) return { ok: false, reason: 'amount' };
  if (lamports > vault.spendable) return { ok: false, reason: 'balance' };
  const dest = destinationInput.trim();
  if (!isAddress(dest) || dest === vault.address || RESERVED_KEYS.has(dest)) return { ok: false, reason: 'destination' };
  const destination = address(dest);
  const account = await readAccount(VAULT_CLUSTER, destination);
  if (account?.executable || account?.owner === 'Sysvar1111111111111111111111111111111111111') return { ok: false, reason: 'destination' };
  if (!account) {
    const minimum = await rpc(VAULT_CLUSTER).getMinimumBalanceForRentExemption(0n).send();
    if (lamports < minimum) return { ok: false, reason: 'rent' };
  }
  return { ok: true, lamports, destination };
}

// ---------- signed messages (mirror qanary_vault::state::Action::message) ----------

function header(tag: number, vault: Address, nonce: number, nextKey: Uint8Array) {
  return concat(text.encode(MESSAGE_DOMAIN), Uint8Array.of(tag), bytes(VAULT_PROGRAM), bytes(vault), u32be(nonce), nextKey);
}

export const withdrawSolMessage = (vault: Address, nonce: number, nextKey: Uint8Array, destination: Address, amount: bigint) =>
  concat(header(1, vault, nonce, nextKey), bytes(destination), u64le(amount));

export const setOwnerMessage = (vault: Address, nonce: number, nextKey: Uint8Array, owner: Address | null) =>
  concat(header(3, vault, nonce, nextKey), option(owner));

// ---------- instructions ----------

const ro = (a: Address) => ({ address: a, role: AccountRole.READONLY });
const rw = (a: Address) => ({ address: a, role: AccountRole.WRITABLE });
const rws = (a: Address) => ({ address: a, role: AccountRole.WRITABLE_SIGNER });
const ros = (a: Address) => ({ address: a, role: AccountRole.READONLY_SIGNER });

export const computeLimitIx = (units: number): Instruction => ({
  programAddress: COMPUTE_BUDGET,
  accounts: [],
  data: concat(Uint8Array.of(2), u32le(units)),
});

export const transferIx = (from: Address, to: Address, lamports: bigint): Instruction => ({
  programAddress: SYSTEM_PROGRAM,
  accounts: [rws(from), rw(to)],
  data: concat(u32le(2), u64le(lamports)),
});

export const createVaultIx = (payer: Address, vault: Address, keys: Pick<VaultKeys, 'id' | 'genesisKey'>): Instruction => ({
  programAddress: VAULT_PROGRAM,
  accounts: [rws(payer), rw(vault), ro(SYSTEM_PROGRAM)],
  data: concat(ixTag('create_vault'), keys.id, keys.genesisKey),
});

export const pqWithdrawSolIx = (vault: Address, destination: Address, signature: Uint8Array, amount: bigint, nextKey: Uint8Array): Instruction => ({
  programAddress: VAULT_PROGRAM,
  accounts: [rw(vault), rw(destination)],
  data: concat(ixTag('pq_withdraw_sol'), u32le(signature.length), signature, u64le(amount), nextKey),
});

export const pqSetOwnerIx = (vault: Address, signature: Uint8Array, owner: Address | null, nextKey: Uint8Array): Instruction => ({
  programAddress: VAULT_PROGRAM,
  accounts: [rw(vault)],
  data: concat(ixTag('pq_set_owner'), u32le(signature.length), signature, option(owner), nextKey),
});

export const withdrawSolIx = (vault: Address, owner: Address, destination: Address, canary: Address, amount: bigint): Instruction => ({
  programAddress: VAULT_PROGRAM,
  accounts: [rw(vault), ros(owner), rw(destination), ro(canary)],
  data: concat(ixTag('withdraw_sol'), u64le(amount)),
});

export const initializeCanaryIx = (payer: Address, canary: Address): Instruction => ({
  programAddress: BOUNTY_PROGRAM,
  accounts: [rws(payer), rw(canary), ro(CANARY_KEY), ro(SYSTEM_PROGRAM)],
  data: ixTag('initialize'),
});

export const fundIx = (funder: Address, canary: Address, amount: bigint): Instruction => ({
  programAddress: BOUNTY_PROGRAM,
  accounts: [rws(funder), rw(canary), ro(SYSTEM_PROGRAM)],
  data: concat(ixTag('fund'), u64le(amount)),
});

/** Deposits into the honeypot and records the new balance atomically. */
export const fundHoneypotIx = (funder: Address, canary: Address, amount: bigint): Instruction => ({
  programAddress: BOUNTY_PROGRAM,
  accounts: [rws(funder), rw(CANARY_KEY), rw(canary), ro(SYSTEM_PROGRAM)],
  data: concat(ixTag('fund_honeypot'), u64le(amount)),
});

export const checkHoneypotIx = (canary: Address): Instruction => ({
  programAddress: BOUNTY_PROGRAM,
  accounts: [ro(CANARY_KEY), rw(canary)],
  data: ixTag('check_honeypot'),
});

// ---------- sending ----------

/** Thrown when a transaction was sent but its fate is unknown: it may still land. */
export class MaybeLanded extends Error {
  constructor(
    readonly signature: string,
    options?: ErrorOptions,
  ) {
    super('The transaction was sent but not confirmed in time. It may still land: check the explorer before trying again.', options);
  }
}

/** RPC errors in a row, while waiting for a sent transaction, after which its fate is reported as unknown. */
const CONFIRM_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One RPC read while confirming, retried every second. The wallet has already sent the transaction, so an RPC that
 *  keeps failing leaves its fate unknown: that is MaybeLanded (check the explorer), never a bare network error. */
async function readWhileSent<T>(signature: string, request: () => Promise<T>): Promise<T> {
  for (let failures = 1; ; failures++) {
    try {
      return await request();
    } catch (e) {
      if (failures === CONFIRM_ATTEMPTS) throw new MaybeLanded(signature, { cause: e });
      await sleep(1000);
    }
  }
}

async function confirm(cluster: Cluster, signature: string, lastValidBlockHeight: bigint): Promise<void> {
  for (;;) {
    const { value } = await readWhileSent(signature, () => rpc(cluster).getSignatureStatuses([signature as never]).send());
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
    const height = await readWhileSent(signature, () => rpc(cluster).getBlockHeight().send());
    if (height > lastValidBlockHeight) throw new MaybeLanded(signature);
    await sleep(1000);
  }
}

/** Progress of `send`: waiting for the wallet to approve, then waiting for the network to confirm. */
export type SendStep = 'approve' | 'confirm';

/** Builds a v0 transaction on `cluster` paid by the connected wallet, has the wallet sign and send it, and waits until
 *  it lands or its blockhash expires. */
export async function send(
  cluster: Cluster,
  wallet: StandardWallet,
  account: WalletAccount,
  instructions: Instruction[],
  onStep?: (s: SendStep) => void,
): Promise<string> {
  const { value: blockhash } = await rpc(cluster).getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(account.address), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const wire = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  onStep?.('approve');
  const signature = getBase58Decoder().decode(await signAndSend(wallet, account, wire, NETWORKS[cluster].chain));
  onStep?.('confirm');
  await confirm(cluster, signature, blockhash.lastValidBlockHeight);
  return signature;
}

// ---------- one-time key safety ----------

/** What a one-time key signed, so the identical request can be re-sent if its transaction was dropped. */
export type SignedRequest = { kind: 'withdrawSol'; destination: string; amount: string } | { kind: 'setOwner'; owner: string | null };
type Pending = { message: string; signature: string; request: SignedRequest };

const PENDING_PREFIX = 'qanary:signed:';
/** Survives storage failures within this page. */
const memoryPending = new Map<string, Pending>();

export class KeyAlreadyUsed extends Error {
  constructor(
    readonly nonce: number,
    readonly pending: SignedRequest,
  ) {
    super(`One-time key #${nonce} already signed a different request.`);
  }
}

/** The current key signed a request this app cannot re-send (a token withdrawal from another client). */
export class KeyUsedElsewhere extends Error {
  constructor(readonly nonce: number) {
    super(`One-time key #${nonce} already signed a token withdrawal from another app. Finish that request there: signing a different one would weaken the key.`);
  }
}

/** This browser signed one request with the current key, but another device put a different one on-chain. The
 *  on-chain request becomes the only one the key may send; the one signed here is never sent. */
export class KeySignedElsewhere extends UserFacingError {
  constructor(
    readonly nonce: number,
    readonly onChain: SignedRequest,
  ) {
    super(t('keySignedElsewhere', { n: nonce }));
  }
}

export class StorageUnavailable extends Error {
  constructor() {
    super('This browser blocks site storage, so post-quantum signing is disabled: a retry could otherwise reuse a one-time key.');
  }
}

export class LocksUnavailable extends Error {
  constructor() {
    super('This browser cannot lock signing across tabs (Web Locks), so post-quantum signing is disabled. Update the browser and try again.');
  }
}

/** The request a one-time key already signed but that has not landed yet, if any. Read-only. */
export function pendingFor(vault: Address, nonce: number): SignedRequest | null {
  const slot = `${PENDING_PREFIX}${vault}:${nonce}`;
  try {
    const stored = memoryPending.get(slot) ?? (JSON.parse(localStorage.getItem(slot) ?? 'null') as Pending | null);
    return stored?.request ?? null;
  } catch {
    return memoryPending.get(slot)?.request ?? null;
  }
}

/** Throws unless localStorage can persist a record across reloads. */
function assertStorage() {
  try {
    const probe = `${PENDING_PREFIX}probe`;
    localStorage.setItem(probe, '1');
    const ok = localStorage.getItem(probe) === '1';
    localStorage.removeItem(probe);
    if (!ok) throw new Error();
  } catch {
    throw new StorageUnavailable();
  }
}

const TAG_WITHDRAW_SOL = toHex(ixTag('pq_withdraw_sol'));
const TAG_WITHDRAW_TOKEN = toHex(ixTag('pq_withdraw_token'));
const TAG_SET_OWNER = toHex(ixTag('pq_set_owner'));

const withdrawTokenMessage = (vault: Address, nonce: number, nextKey: Uint8Array, mint: Address, destination: Address, amount: bigint) =>
  concat(header(2, vault, nonce, nextKey), bytes(mint), bytes(destination), u64le(amount));

/** An instruction as it appears in a landed transaction. */
export type SeenInstruction = { program: string; accounts: string[]; data: Uint8Array };
/** A request the vault's current key signed, found on-chain. `request` is null for token withdrawals. */
export type SeenSignature = { message: Uint8Array; signature: Uint8Array; request: SignedRequest | null };

/**
 * Finds an instruction carrying a valid signature by the vault's current key (`vault.nonce`). Decodes each
 * post-quantum instruction, rebuilds the message it signs and checks it with LM-OTS against `vault.key`, so
 * signatures by older keys and malformed or forged data are ignored.
 */
export function signedByCurrentKey(instructions: SeenInstruction[], vault: VaultState): SeenSignature | null {
  for (const ix of instructions) {
    const d = ix.data;
    if (ix.program !== VAULT_PROGRAM || ix.accounts[0] !== vault.address || d.length < 12) continue;
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (view.getUint32(8, true) !== lmots.SIG_LEN || d.length < 12 + lmots.SIG_LEN) continue;
    const tag = toHex(d.slice(0, 8));
    const signature = d.slice(12, 12 + lmots.SIG_LEN);
    const args = d.slice(12 + lmots.SIG_LEN);
    const argView = new DataView(args.buffer, args.byteOffset, args.byteLength);
    let seen: Omit<SeenSignature, 'signature'> | null = null;
    if (tag === TAG_WITHDRAW_SOL && args.length === 8 + lmots.N && ix.accounts.length >= 2) {
      const amount = argView.getBigUint64(0, true);
      const destination = address(ix.accounts[1]);
      seen = {
        message: withdrawSolMessage(vault.address, vault.nonce, args.slice(8), destination, amount),
        request: { kind: 'withdrawSol', destination, amount: amount.toString() },
      };
    } else if (tag === TAG_SET_OWNER && (args.length === 1 + lmots.N || args.length === 33 + lmots.N)) {
      const owner = args[0] === 1 && args.length === 33 + lmots.N ? addrDec.decode(args.slice(1, 33)) : null;
      if (args[0] !== (owner ? 1 : 0)) continue;
      seen = { message: setOwnerMessage(vault.address, vault.nonce, args.slice(owner ? 33 : 1), owner), request: { kind: 'setOwner', owner } };
    } else if (tag === TAG_WITHDRAW_TOKEN && args.length === 8 + lmots.N && ix.accounts.length >= 4) {
      const amount = argView.getBigUint64(0, true);
      const message = withdrawTokenMessage(vault.address, vault.nonce, args.slice(8), address(ix.accounts[1]), address(ix.accounts[3]), amount);
      seen = { message, request: null };
    }
    if (!seen) continue;
    const key = lmots.candidatePublicKey(vault.id, vault.nonce, seen.message, signature);
    if (key && toHex(key) === toHex(vault.key)) return { ...seen, signature };
  }
  return null;
}

const PQ_TAGS: ReadonlySet<string> = new Set([TAG_WITHDRAW_SOL, TAG_WITHDRAW_TOKEN, TAG_SET_OWNER]);

/** The keys post-quantum instructions on `vault` handed over to (their `next_key`, hex). Only asked of transactions
 *  that succeeded, where the program has already verified each signature. */
function handOvers(instructions: SeenInstruction[], vault: VaultState): string[] {
  return instructions
    .filter(
      (ix) =>
        ix.program === VAULT_PROGRAM && ix.accounts[0] === vault.address && ix.data.length >= 12 + lmots.N && PQ_TAGS.has(toHex(ix.data.slice(0, 8))),
    )
    .map((ix) => toHex(ix.data.slice(-lmots.N)));
}

/** The vault's history is read newest first, this many signatures per request. */
const HISTORY_PAGE = 100;
/** The most transactions read while looking back for the one that handed over to the current key. Normal use needs a
 *  handful; past this (a vault flooded with dust, say) signing is refused rather than done on a partial check. */
export const HISTORY_CAP = 1_000;

/** The vault's history since the current key took over could not be read in full, so nothing was signed: a
 *  request another device signed could be in the part not read. */
export class HistoryIncomplete extends UserFacingError {
  constructor(
    readonly nonce: number,
    readonly reason: 'unreadable' | 'tooLong',
    options?: ErrorOptions,
  ) {
    super(
      reason === 'tooLong' ? t('historyTooLong', { n: nonce, max: HISTORY_CAP }) : tOn(VAULT_CLUSTER, 'historyUnreadable', { n: nonce }),
      options,
    );
  }
}

type JsonInstruction = { programIdIndex: number; accounts: number[]; data: string };
type JsonTransaction = {
  transaction: { message: { accountKeys: string[]; instructions: JsonInstruction[] } };
  meta: { loadedAddresses?: { writable: string[]; readonly: string[] }; innerInstructions?: { instructions: JsonInstruction[] }[] | null } | null;
};

/** Every instruction of a landed transaction, those other programs ran through CPI included. */
function instructionsOf(tx: JsonTransaction): SeenInstruction[] {
  const base58 = getBase58Encoder();
  const loaded = tx.meta?.loadedAddresses;
  const keys = [...tx.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);
  return [...tx.transaction.message.instructions, ...inner].map((ix) => ({
    program: keys[ix.programIdIndex],
    accounts: ix.accounts.map((i) => keys[i]),
    data: new Uint8Array(base58.encode(ix.data)),
  }));
}

/**
 * A request the current key already signed in a transaction that landed (and failed), from any device. A request
 * that succeeds moves the vault to the next key, so the current key can only appear in failed transactions after
 * the one that handed over to it. The history is read back to that transaction, or for key #0 to the very first
 * one (failed creates included). Throws `HistoryIncomplete` rather than answer from part of it: on an RPC error,
 * past HISTORY_CAP transactions, or when the history ends or shows another hand-over before the current key's.
 */
async function signedOnChain(vault: VaultState): Promise<SeenSignature | null> {
  try {
    let before: Signature | undefined;
    for (let read = 0; ; ) {
      const page = await rpc(VAULT_CLUSTER).getSignaturesForAddress(vault.address, { limit: HISTORY_PAGE, before }).send();
      if (page.length === 0) {
        if (vault.nonce === 0) return null;
        throw new HistoryIncomplete(vault.nonce, 'unreadable');
      }
      for (const entry of page) {
        if (++read > HISTORY_CAP) throw new HistoryIncomplete(vault.nonce, 'tooLong');
        const tx = (await rpc(VAULT_CLUSTER)
          .getTransaction(entry.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 })
          .send()) as unknown as JsonTransaction | null;
        if (!tx) {
          // A failed transaction that cannot be read could carry the key; a successful one only marks where to stop.
          if (entry.err) throw new HistoryIncomplete(vault.nonce, 'unreadable');
          continue;
        }
        const instructions = instructionsOf(tx);
        if (entry.err) {
          const seen = signedByCurrentKey(instructions, vault);
          if (seen) return seen;
          continue;
        }
        const next = handOvers(instructions, vault);
        if (next.includes(toHex(vault.key))) return null;
        // Any other hand-over first: this read missed the current key's, or the vault moved on after it was read.
        if (next.length > 0) throw new HistoryIncomplete(vault.nonce, 'unreadable');
      }
      before = page[page.length - 1].signature;
    }
  } catch (e) {
    throw e instanceof HistoryIncomplete ? e : new HistoryIncomplete(vault.nonce, 'unreadable', { cause: e });
  }
}

function remember(slot: string, record: Pending) {
  memoryPending.set(slot, record);
  localStorage.setItem(slot, JSON.stringify(record));
}

/**
 * Returns the signature for `request` by the vault's current one-time key, creating it at most once. An
 * LM-OTS key must never sign two different messages, so:
 * - a lock held across every tab of this site makes check-then-sign atomic;
 * - the vault's history since the key took over is read every time, stored record or not: a request
 *   another device signed and that landed (and failed) is found and verified, and becomes the only one
 *   this browser will sign or send, even if it had signed a different one itself;
 * - otherwise, a request this browser already signed with the key is the only one it will sign again.
 * A different request then throws `KeyAlreadyUsed` (`KeySignedElsewhere` when this browser's own request
 * lost to another device's, `KeyUsedElsewhere` for a token withdrawal) until the first one lands and the
 * nonce moves on. If the history cannot be read in full, nothing is signed (`HistoryIncomplete`).
 * Signatures are deterministic, so the same request yields the same bytes anywhere.
 * The remaining risk is two devices signing different requests while neither has landed yet.
 */
export async function oneTimeSignature(keys: VaultKeys, vault: VaultState, message: Uint8Array, request: SignedRequest): Promise<Uint8Array> {
  assertStorage();
  if (!('locks' in navigator) || !navigator.locks) throw new LocksUnavailable();
  const slot = `${PENDING_PREFIX}${vault.address}:${vault.nonce}`;
  return navigator.locks.request(slot, async () => {
    const stored = memoryPending.get(slot) ?? (JSON.parse(localStorage.getItem(slot) ?? 'null') as Pending | null);
    const messageHex = toHex(message);
    const seen = await signedOnChain(vault);
    if (seen) {
      const seenHex = toHex(seen.message);
      if (seenHex === messageHex) {
        remember(slot, { message: messageHex, signature: toHex(seen.signature), request });
        return seen.signature;
      }
      if (!seen.request) throw new KeyUsedElsewhere(vault.nonce);
      remember(slot, { message: seenHex, signature: toHex(seen.signature), request: seen.request });
      if (stored && stored.message !== seenHex) throw new KeySignedElsewhere(vault.nonce, seen.request);
      throw new KeyAlreadyUsed(vault.nonce, seen.request);
    }
    if (stored) {
      if (stored.message !== messageHex) throw new KeyAlreadyUsed(vault.nonce, stored.request);
      return fromHex(stored.signature);
    }
    const signature = lmots.signDeterministic(keys.id, vault.nonce, keys.seed, message);
    remember(slot, { message: messageHex, signature: toHex(signature), request });
    return signature;
  });
}
