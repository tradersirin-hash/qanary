// Client for the Qanary Vault and Qanary Bounty programs on devnet: PDAs, account decoding,
// instruction encoding (Anchor layout), request validation and wallet-signed sends.
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
  devnet as devnetCluster,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getProgramDerivedAddress,
  getTransactionEncoder,
  isAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';
import { BOUNTY_PROGRAM_ID, CANARY_KEY_ID, VAULT_PROGRAM_ID } from './constants';
import * as lmots from './lmots';
import { signAndSend, type StandardWallet, type WalletAccount } from './wallet';

export const devnet = createSolanaRpc(devnetCluster(import.meta.env.VITE_DEVNET_RPC || 'https://api.devnet.solana.com'));

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

/** Exact decimal SOL string to lamports (no float math). Returns null if it is not a valid amount. */
export function parseSol(input: string): bigint | null {
  const m = input.trim().match(/^(\d+)(?:\.(\d{1,9}))?$/);
  if (!m) return null;
  const lamports = BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] ?? '').padEnd(9, '0'));
  return lamports <= U64_MAX ? lamports : null;
}

// ---------- keys ----------

export type VaultKeys = { id: Uint8Array; seed: Uint8Array; genesisKey: Uint8Array };

const normalize = (phrase: string) => phrase.trim().toLowerCase().split(/\s+/).join(' ');
export const isValidPhrase = (phrase: string) => validateMnemonic(normalize(phrase), wordlist);

/** The 24-word phrase is the only secret: it yields the vault id, the LM-OTS seed and so every key. */
export function deriveKeys(phrase: string): VaultKeys {
  const master = mnemonicToSeedSync(normalize(phrase));
  const id = sha256(concat(text.encode('qanary/vault-id/v1'), master)).slice(0, lmots.ID_LEN);
  const seed = sha256(concat(text.encode('qanary/lmots-seed/v1'), master)).slice(0, lmots.N);
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

async function readAccount(a: Address) {
  const { value } = await devnet.getAccountInfo(a, { encoding: 'base64' }).send();
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
  const account = await readAccount(a);
  // Exactly the vault layout: anything else owned by the program (or a future layout) is not read as a vault.
  if (!account || account.owner !== VAULT_PROGRAM || account.data.length !== VAULT_SPACE) return null;
  const d = account.data;
  const nonce = new DataView(d.buffer, d.byteOffset).getUint32(72, true);
  const owner = d[76] === 1 ? addrDec.decode(d.slice(77, 109)) : null;
  const rent = await devnet.getMinimumBalanceForRentExemption(BigInt(VAULT_SPACE)).send();
  const spendable = account.lamports > rent ? account.lamports - rent : 0n;
  return { address: a, id: d.slice(8, 24), genesisKey: d.slice(24, 48), key: d.slice(48, 72), nonce, owner, lamports: account.lamports, spendable };
}

export type CanaryState = {
  address: Address;
  tripped: boolean;
  claimer: Address | null;
  honeypotBaseline: bigint;
  honeypotLamports: bigint;
  totalFunded: bigint;
  pool: bigint;
};

export async function fetchCanary(): Promise<CanaryState | null> {
  const a = await canaryAddress();
  const [account, honeypot, rent] = await Promise.all([
    readAccount(a),
    devnet.getBalance(CANARY_KEY).send(),
    devnet.getMinimumBalanceForRentExemption(BigInt(CANARY_SPACE)).send(),
  ]);
  if (!account || account.owner !== BOUNTY_PROGRAM || account.data.length < 66) return null;
  const d = account.data;
  const view = new DataView(d.buffer, d.byteOffset);
  const claimer = addrDec.decode(d.slice(17, 49));
  return {
    address: a,
    tripped: d[8] === 1,
    claimer: claimer === SYSTEM_PROGRAM ? null : claimer,
    honeypotBaseline: view.getBigUint64(49, true),
    honeypotLamports: honeypot.value as bigint,
    totalFunded: view.getBigUint64(57, true),
    pool: account.lamports > rent ? account.lamports - rent : 0n,
  };
}

/** True once the bounty program is deployed on devnet (its canary may still need initializing). */
export async function bountyDeployed(): Promise<boolean> {
  const account = await readAccount(BOUNTY_PROGRAM);
  return account?.executable === true;
}

// ---------- request validation (before any one-time key signs) ----------

export type WithdrawCheck = { ok: true; lamports: bigint; destination: Address } | { ok: false; reason: 'amount' | 'balance' | 'destination' | 'rent' };

/** Rejects requests the program would not execute, so a one-time key is never spent on them. */
export async function checkWithdraw(vault: VaultState, amountInput: string, destinationInput: string): Promise<WithdrawCheck> {
  const lamports = parseSol(amountInput);
  if (lamports === null || lamports === 0n) return { ok: false, reason: 'amount' };
  if (lamports > vault.spendable) return { ok: false, reason: 'balance' };
  const dest = destinationInput.trim();
  if (!isAddress(dest) || dest === vault.address) return { ok: false, reason: 'destination' };
  const destination = address(dest);
  const account = await readAccount(destination);
  if (account?.executable || account?.owner === 'Sysvar1111111111111111111111111111111111111') return { ok: false, reason: 'destination' };
  if (!account) {
    const minimum = await devnet.getMinimumBalanceForRentExemption(0n).send();
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
  constructor(readonly signature: string) {
    super('The transaction was sent but not confirmed in time. It may still land: check the explorer before trying again.');
  }
}

async function confirm(signature: string, lastValidBlockHeight: bigint): Promise<void> {
  for (;;) {
    const { value } = await devnet.getSignatureStatuses([signature as never]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
    const height = await devnet.getBlockHeight().send();
    if (height > lastValidBlockHeight) throw new MaybeLanded(signature);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Progress of `send`: waiting for the wallet to approve, then waiting for the network to confirm. */
export type SendStep = 'approve' | 'confirm';

/** Builds a v0 transaction paid by the connected wallet, has the wallet sign and send it, and waits until it lands or its blockhash expires. */
export async function send(wallet: StandardWallet, account: WalletAccount, instructions: Instruction[], onStep?: (s: SendStep) => void): Promise<string> {
  const { value: blockhash } = await devnet.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(account.address), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const wire = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  onStep?.('approve');
  const signature = getBase58Decoder().decode(await signAndSend(wallet, account, wire));
  onStep?.('confirm');
  await confirm(signature, blockhash.lastValidBlockHeight);
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

export class StorageUnavailable extends Error {
  constructor() {
    super('This browser blocks site storage, so post-quantum signing is disabled: a retry could otherwise reuse a one-time key.');
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

/**
 * Returns the signature for (vault, nonce, message), creating it at most once. An LM-OTS key must
 * never sign two different messages: a different request for the same key throws `KeyAlreadyUsed`
 * until the first one lands (the on-chain nonce then moves on). Signatures are deterministic, so
 * an identical request yields identical bytes even on another device. Different requests from two
 * devices for the same key are the remaining risk: use one device at a time.
 */
export function oneTimeSignature(keys: VaultKeys, vault: Address, nonce: number, message: Uint8Array, request: SignedRequest): Uint8Array {
  assertStorage();
  const slot = `${PENDING_PREFIX}${vault}:${nonce}`;
  const stored = memoryPending.get(slot) ?? (JSON.parse(localStorage.getItem(slot) ?? 'null') as Pending | null);
  const messageHex = toHex(message);
  if (stored) {
    if (stored.message !== messageHex) throw new KeyAlreadyUsed(nonce, stored.request);
    return fromHex(stored.signature);
  }
  const signature = lmots.signDeterministic(keys.id, nonce, keys.seed, message);
  const record: Pending = { message: messageHex, signature: toHex(signature), request };
  memoryPending.set(slot, record);
  localStorage.setItem(slot, JSON.stringify(record));
  return signature;
}
