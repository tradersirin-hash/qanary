import { sha256 } from '@noble/hashes/sha2';
import { address, getBase58Decoder, type Instruction } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lmots from './lmots';
import {
  createVaultIx,
  deriveKeys,
  HISTORY_CAP,
  HistoryIncomplete,
  KeyAlreadyUsed,
  KeySignedElsewhere,
  oneTimeSignature,
  pendingFor,
  pqSetOwnerIx,
  pqWithdrawSolIx,
  setOwnerMessage,
  signedByCurrentKey,
  transferIx,
  VAULT_PROGRAM,
  withdrawSolMessage,
  type SeenInstruction,
  type SignedRequest,
  type VaultState,
} from './qanary';

/** The vault's history as the RPC serves it, newest first. A `tx` of 'error' makes reading that transaction fail. */
const chain = vi.hoisted(() => ({ history: [] as { signature: string; err: unknown; tx: unknown }[], reads: 0, down: false }));

vi.mock('@solana/kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/kit')>()),
  createSolanaRpc: () => ({
    getSignaturesForAddress: (_address: string, { before, limit }: { before?: string; limit: number }) => ({
      send: async () => {
        chain.reads++;
        if (chain.down) throw new Error('fetch failed');
        const start = before ? chain.history.findIndex((e) => e.signature === before) + 1 : 0;
        return chain.history.slice(start, start + limit).map(({ signature, err }) => ({ signature, err }));
      },
    }),
    getTransaction: (signature: string) => ({
      send: async () => {
        const tx = chain.history.find((e) => e.signature === signature)?.tx;
        if (tx === 'error') throw new Error('HTTP error (429): Too Many Requests');
        return tx ?? null;
      },
    }),
  }),
}));

const keys = deriveKeys(`${'abandon '.repeat(23)}art`);
const VAULT = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const DEST = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
const OWNER = address('HG9k4yEyErN3bAmtoXLMvNNmaDhcQJqEbP3PXpr9j8XX');
const Q = 3;

/** The vault as the chain shows it while key `q` is current. */
const vaultAt = (q: number): VaultState => ({
  address: VAULT,
  id: keys.id,
  genesisKey: keys.genesisKey,
  key: lmots.publicKey(keys.id, q, keys.seed),
  nonce: q,
  owner: null,
  lamports: 0n,
  spendable: 0n,
});
const nextKey = (q: number) => lmots.publicKey(keys.id, q + 1, keys.seed);
const seen = (ix: Instruction): SeenInstruction => ({
  program: ix.programAddress,
  accounts: (ix.accounts ?? []).map((a) => a.address),
  data: new Uint8Array(ix.data ?? []),
});

function withdrawInstruction(q: number, signedBy = q, amount = 5_000n) {
  const message = withdrawSolMessage(VAULT, q, nextKey(q), DEST, amount);
  const signature = lmots.signDeterministic(keys.id, signedBy, keys.seed, message);
  return pqWithdrawSolIx(VAULT, DEST, signature, amount, nextKey(q));
}
const withdrawIx = (q: number, signedBy = q, amount = 5_000n) => seen(withdrawInstruction(q, signedBy, amount));

describe('signedByCurrentKey', () => {
  it('finds a withdrawal the current key signed and recovers the exact request', () => {
    const found = signedByCurrentKey([withdrawIx(Q)], vaultAt(Q));
    expect(found?.request).toEqual({ kind: 'withdrawSol', destination: DEST, amount: '5000' });
    expect(found?.message).toEqual(withdrawSolMessage(VAULT, Q, nextKey(Q), DEST, 5_000n));
  });

  it('finds owner changes, with and without an owner', () => {
    for (const owner of [OWNER, null]) {
      const message = setOwnerMessage(VAULT, Q, nextKey(Q), owner);
      const signature = lmots.signDeterministic(keys.id, Q, keys.seed, message);
      const found = signedByCurrentKey([seen(pqSetOwnerIx(VAULT, signature, owner, nextKey(Q)))], vaultAt(Q));
      expect(found?.request).toEqual({ kind: 'setOwner', owner });
    }
  });

  it('ignores signatures by older keys, other vaults, other programs and tampered data', () => {
    expect(signedByCurrentKey([withdrawIx(Q - 1)], vaultAt(Q)), 'older key, older message').toBeNull();
    expect(signedByCurrentKey([withdrawIx(Q, Q - 1)], vaultAt(Q)), 'signed by another key').toBeNull();

    const other = { ...withdrawIx(Q), program: 'Stake11111111111111111111111111111111111111' };
    expect(signedByCurrentKey([other], vaultAt(Q)), 'other program').toBeNull();
    const otherVault = { ...withdrawIx(Q), accounts: [DEST, DEST] };
    expect(signedByCurrentKey([otherVault], vaultAt(Q)), 'other vault').toBeNull();

    const tampered = withdrawIx(Q);
    tampered.data[tampered.data.length - lmots.N - 8] ^= 1; // the amount
    expect(signedByCurrentKey([tampered], vaultAt(Q)), 'amount changed').toBeNull();
    expect(signedByCurrentKey([{ ...withdrawIx(Q), data: withdrawIx(Q).data.slice(0, 40) }], vaultAt(Q)), 'truncated').toBeNull();
  });

  it('recognises a token withdrawal by the current key, which this app cannot re-send', () => {
    const mint = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const amount = new Uint8Array(8);
    new DataView(amount.buffer).setBigUint64(0, 42n, true);
    // The program's token message: domain | 2 | program | vault | q | next key | mint | destination | amount.
    const sol = withdrawSolMessage(VAULT, Q, nextKey(Q), DEST, 0n);
    const prefix = sol.slice(0, sol.length - 32 - 8);
    prefix['qanary-vault-v1'.length] = 2;
    const message = new Uint8Array([...prefix, ...bs58(mint), ...bs58(DEST), ...amount]);
    const signature = lmots.signDeterministic(keys.id, Q, keys.seed, message);
    const tag = sha256(new TextEncoder().encode('global:pq_withdraw_token')).slice(0, 8);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, signature.length, true);
    const data = new Uint8Array([...tag, ...len, ...signature, ...amount, ...nextKey(Q)]);
    const ata = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
    const ix: SeenInstruction = { program: VAULT_PROGRAM, accounts: [VAULT, mint, ata, DEST, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], data };
    const found = signedByCurrentKey([ix], vaultAt(Q));
    expect(found?.message).toEqual(message);
    expect(found?.request).toBeNull();
  });
});

const base58 = getBase58Decoder();
/** A landed transaction as getTransaction returns it (json encoding). */
function landed(...ixs: Instruction[]) {
  const accountKeys: string[] = [];
  const at = (a: string) => (accountKeys.includes(a) ? accountKeys.indexOf(a) : accountKeys.push(a) - 1);
  const instructions = ixs.map((ix) => ({
    programIdIndex: at(ix.programAddress),
    accounts: (ix.accounts ?? []).map((a) => at(a.address)),
    data: base58.decode(ix.data ?? new Uint8Array()),
  }));
  return { transaction: { message: { accountKeys, instructions } }, meta: { loadedAddresses: { writable: [], readonly: [] } } };
}

let landedCount = 0;
const FAILED = { InstructionError: [1, { Custom: 6000 }] };
const ok = (...ixs: Instruction[]) => ({ signature: `ok${landedCount++}`, err: null, tx: landed(...ixs) });
const failed = (...ixs: Instruction[]) => ({ signature: `failed${landedCount++}`, err: FAILED, tx: landed(...ixs) });
const deposits = (n: number) => Array.from({ length: n }, () => ok(transferIx(OWNER, VAULT, 1_000n)));
/** The withdrawal by key q - 1 that landed and handed over to key q. */
const handOver = (q: number) => ok(withdrawInstruction(q - 1));
/** A failed withdrawal of `amount` signed by key q, as another device would leave it. */
const signedElsewhere = (q: number, amount: bigint) => failed(withdrawInstruction(q, q, amount));

const withdrawal = (amount: bigint): SignedRequest => ({ kind: 'withdrawSol', destination: DEST, amount: amount.toString() });
const withdrawalMessage = (q: number, amount: bigint) => withdrawSolMessage(VAULT, q, nextKey(q), DEST, amount);
/** Asks this browser for key q's signature on a withdrawal. Each test uses its own q: records outlive a test. */
const sign = (q: number, amount = 5_000n) => oneTimeSignature(keys, vaultAt(q), withdrawalMessage(q, amount), withdrawal(amount));
/** The error a request is refused with; fails the test if it was signed. */
const refusal = (q: number, amount = 5_000n) =>
  sign(q, amount).then(
    () => expect.fail('signed'),
    (e: unknown) => e,
  );

describe('oneTimeSignature', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('navigator', { locks: { request: (_name: string, task: () => Promise<unknown>) => task() } });
    chain.history = [];
    chain.reads = 0;
    chain.down = false;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads the chain despite a stored record, and never sends that record once another device put a different request there', async () => {
    const q = 11;
    chain.history = [handOver(q)];
    await sign(q, 5_000n); // signed here, then the wallet popup was closed: never sent
    chain.history = [signedElsewhere(q, 7_000n), ...deposits(2), handOver(q)];
    chain.reads = 0;

    const e = await refusal(q, 5_000n);
    expect(e).toBeInstanceOf(KeySignedElsewhere);
    expect((e as KeySignedElsewhere).onChain).toEqual(withdrawal(7_000n));
    expect(chain.reads).toBeGreaterThan(0);

    // From now on only the on-chain request may go out, with its own bytes; anything else is refused.
    expect(pendingFor(VAULT, q)).toEqual(withdrawal(7_000n));
    await expect(sign(q, 9_000n)).rejects.toBeInstanceOf(KeyAlreadyUsed);
    expect(await sign(q, 7_000n)).toEqual(lmots.signDeterministic(keys.id, q, keys.seed, withdrawalMessage(q, 7_000n)));
  });

  it('reuses the signature when the chain shows the stored request itself', async () => {
    const q = 12;
    chain.history = [handOver(q)];
    const first = await sign(q);
    chain.history = [signedElsewhere(q, 5_000n), ...deposits(2), handOver(q)];
    chain.reads = 0;
    expect(await sign(q)).toEqual(first);
    expect(chain.reads).toBeGreaterThan(0);
    expect(pendingFor(VAULT, q)).toEqual(withdrawal(5_000n));
  });

  it('finds a request another device signed far more than 25 transactions back', async () => {
    const q = 13;
    // Dust deposits push the failed request past the first page of history.
    chain.history = [...deposits(130), signedElsewhere(q, 7_000n), ...deposits(5), handOver(q)];
    const e = await refusal(q);
    expect(e).toBeInstanceOf(KeyAlreadyUsed);
    expect((e as KeyAlreadyUsed).pending).toEqual(withdrawal(7_000n));
    expect(pendingFor(VAULT, q)).toEqual(withdrawal(7_000n));
  });

  it('stops at the transaction that handed over to the current key', async () => {
    const q = 14;
    chain.history = [...deposits(3), handOver(q), { signature: 'older', err: FAILED, tx: 'error' }];
    expect(await sign(q)).toEqual(lmots.signDeterministic(keys.id, q, keys.seed, withdrawalMessage(q, 5_000n)));
  });

  it('reads key #0 back to the first transaction, failed creates included', async () => {
    // Another device's create with wallet access failed: its key #0 signature is older than the vault itself.
    const access = setOwnerMessage(VAULT, 0, nextKey(0), OWNER);
    const accessIx = pqSetOwnerIx(VAULT, lmots.signDeterministic(keys.id, 0, keys.seed, access), OWNER, nextKey(0));
    chain.history = [...deposits(2), ok(createVaultIx(OWNER, VAULT, keys)), failed(createVaultIx(OWNER, VAULT, keys), accessIx)];
    const e = await refusal(0);
    expect(e).toBeInstanceOf(KeyAlreadyUsed);
    expect((e as KeyAlreadyUsed).pending).toEqual({ kind: 'setOwner', owner: OWNER });
  });

  it('signs nothing when the history cannot be read in full', async () => {
    const q = 15;
    const cases: [string, () => void][] = [
      ['RPC down', () => void (chain.down = true)],
      ['a failed transaction that cannot be read', () => void (chain.history = [{ signature: 'x', err: FAILED, tx: 'error' }, handOver(q)])],
      ['a failed transaction the RPC does not return', () => void (chain.history = [{ signature: 'y', err: FAILED, tx: null }, handOver(q)])],
      ['history that ends before the hand-over', () => void (chain.history = deposits(3))],
      ['an RPC that does not list the hand-over yet', () => void (chain.history = [...deposits(3), handOver(q - 1), ...deposits(3)])],
      ['a vault that moved on after it was read', () => void (chain.history = [handOver(q + 1), handOver(q)])],
    ];
    for (const [label, setUp] of cases) {
      chain.down = false;
      setUp();
      const e = await refusal(q);
      expect(e, label).toBeInstanceOf(HistoryIncomplete);
      expect((e as HistoryIncomplete).reason, label).toBe('unreadable');
    }
    expect(pendingFor(VAULT, q)).toBeNull();
  });

  it('signs nothing past HISTORY_CAP transactions, so a flood of dust cannot hide a request', async () => {
    const q = 16;
    chain.history = [...deposits(HISTORY_CAP), handOver(q)];
    const e = await refusal(q);
    expect(e).toBeInstanceOf(HistoryIncomplete);
    expect((e as HistoryIncomplete).reason).toBe('tooLong');
    expect((e as HistoryIncomplete).message).toContain(`${HISTORY_CAP} or more transactions`);
    expect(pendingFor(VAULT, q)).toBeNull();

    chain.history = [...deposits(HISTORY_CAP - 1), handOver(q)];
    expect(await sign(q)).toHaveLength(lmots.SIG_LEN);
  });
});

/** Base58 decode for test addresses. */
function bs58(s: string): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(alphabet.indexOf(c));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
