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
  LocksUnavailable,
  oneTimeSignature,
  pendingFor,
  PendingUnreadable,
  pqSetOwnerIx,
  pqWithdrawSolIx,
  setOwnerMessage,
  signedByCurrentKey,
  StorageUnavailable,
  transferIx,
  VAULT_PROGRAM,
  withdrawSolMessage,
  type SeenInstruction,
  type SignedRequest,
  type VaultState,
} from './qanary';

/** The vault's history as the RPC serves it, newest first. A `tx` of 'error' makes reading that transaction fail, and
 *  every history page after the first `failAfterPages` fails. */
const chain = vi.hoisted(() => ({ history: [] as { signature: string; err: unknown; tx: unknown }[], reads: 0, down: false, failAfterPages: Infinity }));

vi.mock('@solana/kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/kit')>()),
  createSolanaRpc: () => ({
    getSignaturesForAddress: (_address: string, { before, limit }: { before?: string; limit: number }) => ({
      send: async () => {
        chain.reads++;
        if (chain.down || chain.reads > chain.failAfterPages) throw new Error('fetch failed');
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

/** Empty working storage, a Web Lock that runs each task at once, and an empty history that reads without errors. */
function freshBrowser() {
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
  chain.failAfterPages = Infinity;
}

describe('oneTimeSignature', () => {
  beforeEach(freshBrowser);
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

/** Where this browser keeps its record of what key q signed. */
const slot = (q: number) => `qanary:signed:${VAULT}:${q}`;
/** A page reload: a fresh copy of the module with nothing in its memory. Storage and the chain stay as they are. */
async function reload() {
  vi.resetModules();
  return import('./qanary');
}
/** The error a signature request is refused with; fails the test if it was signed. */
const rejection = (request: Promise<unknown>) =>
  request.then(
    () => expect.fail('signed'),
    (e: unknown) => e,
  );
/** Key q's signature on a withdrawal of `amount`: the same bytes on every device. */
const signature = (q: number, amount: bigint) => lmots.signDeterministic(keys.id, q, keys.seed, withdrawalMessage(q, amount));

describe('oneTimeSignature under failures', () => {
  beforeEach(freshBrowser);
  afterEach(() => vi.unstubAllGlobals());

  it('after a reload, only the request signed before it can be sent', async () => {
    const q = 20;
    chain.history = [handOver(q)];
    const first = await sign(q, 5_000n);

    const page = await reload();
    const e = await rejection(page.oneTimeSignature(keys, vaultAt(q), withdrawalMessage(q, 9_000n), withdrawal(9_000n)));
    expect(e).toBeInstanceOf(page.KeyAlreadyUsed);
    expect((e as KeyAlreadyUsed).pending).toEqual(withdrawal(5_000n));
    expect(await page.oneTimeSignature(keys, vaultAt(q), withdrawalMessage(q, 5_000n), withdrawal(5_000n))).toEqual(first);
  });

  it('returns no signature while its record cannot be written', async () => {
    const q = 21;
    chain.history = [handOver(q)];
    const store = new Map<string, string>();
    let full = true;
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      // Only the record fails, so the storage probe still passes.
      setItem: (k: string, v: string) => {
        if (full && k === slot(q)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    });

    await expect(sign(q)).rejects.toThrow('quota');
    await expect(sign(q), 'the same request again').rejects.toThrow('quota');
    // This page still remembers what the key signed, so it signs nothing else with it.
    const e = await refusal(q, 9_000n);
    expect(e).toBeInstanceOf(KeyAlreadyUsed);
    expect((e as KeyAlreadyUsed).pending).toEqual(withdrawal(5_000n));

    // Signing a new request after a reload is safe: no signature by the key ever left the page that made it.
    full = false;
    const page = await reload();
    expect(await page.oneTimeSignature(keys, vaultAt(q), withdrawalMessage(q, 9_000n), withdrawal(9_000n))).toEqual(signature(q, 9_000n));
  });

  it('lets a request another tab signed win over one this page could not write', async () => {
    const q = 28;
    chain.history = [handOver(q)];
    const store = new Map<string, string>();
    let full = true;
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (full && k === slot(q)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    });

    // This page signs, cannot write its record and returns nothing. Space frees up and another tab, which never saw
    // that record, signs a different request and returns it.
    await expect(sign(q, 5_000n)).rejects.toThrow('quota');
    full = false;
    const other = await reload();
    expect(await other.oneTimeSignature(keys, vaultAt(q), withdrawalMessage(q, 9_000n), withdrawal(9_000n))).toEqual(signature(q, 9_000n));

    // The other tab's request may be on its way, so this page must not return its own one now.
    const e = await refusal(q, 5_000n);
    expect(e).toBeInstanceOf(KeyAlreadyUsed);
    expect((e as KeyAlreadyUsed).pending).toEqual(withdrawal(9_000n));
    expect(pendingFor(VAULT, q)).toEqual(withdrawal(9_000n));
  });

  it('signs nothing when its stored record is damaged', async () => {
    const q = 22;
    chain.history = [handOver(q)];
    const damaged = [
      'not json',
      '{}',
      'null',
      JSON.stringify({ message: '00', signature: '00', request: { kind: 'withdrawToken', amount: '1' } }),
      JSON.stringify({ message: '00', signature: '00', request: { kind: 'withdrawSol', destination: DEST } }),
    ];
    for (const record of damaged) {
      localStorage.setItem(slot(q), record);
      expect(await refusal(q), record).toBeInstanceOf(PendingUnreadable);
      expect(pendingFor(VAULT, q), record).toBeNull();
      expect(localStorage.getItem(slot(q)), record).toBe(record);
    }
  });

  it('lets a request found on-chain replace a damaged record', async () => {
    const q = 27;
    chain.history = [signedElsewhere(q, 7_000n), handOver(q)];
    // Each request comes from a reloaded page whose record is damaged, so none is answered from memory.
    const damagedPage = () => {
      localStorage.setItem(slot(q), 'not json');
      return reload();
    };

    let page = await damagedPage();
    expect(await page.oneTimeSignature(keys, vaultAt(q), withdrawalMessage(q, 7_000n), withdrawal(7_000n))).toEqual(signature(q, 7_000n));

    page = await damagedPage();
    const e = await rejection(page.oneTimeSignature(keys, vaultAt(q), withdrawalMessage(q, 9_000n), withdrawal(9_000n)));
    expect(e).toBeInstanceOf(page.KeyAlreadyUsed);
    expect((e as KeyAlreadyUsed).pending).toEqual(withdrawal(7_000n));
    // Replaced in storage, not only in that page's memory.
    expect(pendingFor(VAULT, q)).toEqual(withdrawal(7_000n));
  });

  it('signs nothing when a later page of the history fails', async () => {
    const q = 23;
    chain.history = [...deposits(150), handOver(q)];
    chain.failAfterPages = 1;
    const e = await refusal(q);
    expect(e).toBeInstanceOf(HistoryIncomplete);
    expect((e as HistoryIncomplete).reason).toBe('unreadable');
    expect(chain.reads).toBe(2);
    expect(pendingFor(VAULT, q)).toBeNull();
  });

  it('signs one of two requests made at once from two tabs, and refuses the other', async () => {
    const q = 24;
    chain.history = [handOver(q)];
    // Web Locks: a task starts once the one before it under the same name has finished.
    const queues = new Map<string, Promise<unknown>>();
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string, task: () => Promise<unknown>) => {
          const run = (queues.get(name) ?? Promise.resolve()).then(task);
          queues.set(name, run.catch(() => undefined));
          return run;
        },
      },
    });

    // The second tab is its own copy of the module: it shares only storage, the lock and the chain with the first.
    const other = await reload();
    const results = await Promise.allSettled([
      sign(q, 5_000n),
      other.oneTimeSignature(keys, vaultAt(q), withdrawalMessage(q, 9_000n), withdrawal(9_000n)),
    ]);
    const signed = results.filter((r): r is PromiseFulfilledResult<Uint8Array> => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(signed.map((r) => r.value)).toEqual([signature(q, 5_000n)]);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(other.KeyAlreadyUsed);
    expect((refused[0].reason as KeyAlreadyUsed).pending).toEqual(withdrawal(5_000n));
  });

  it('signs nothing without Web Locks or storage, and does not read the chain', async () => {
    chain.history = [handOver(25)];
    vi.stubGlobal('navigator', {});
    expect(await refusal(25)).toBeInstanceOf(LocksUnavailable);
    expect(chain.reads).toBe(0);

    freshBrowser();
    chain.history = [handOver(26)];
    // As blocked site storage does: every write throws, the probe's included.
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
      removeItem: () => undefined,
    });
    expect(await refusal(26)).toBeInstanceOf(StorageUnavailable);
    expect(chain.reads).toBe(0);
  });

  it('never throws on arbitrary instruction data in the vault history, and never takes it for a signature', () => {
    const SEED = 0x9e3779b9;
    const random = xorshift32(SEED);
    const below = (n: number) => random() % n;
    const randomBytes = (n: number) => Uint8Array.from({ length: n }, () => random() & 0xff);
    const pqTags = ['pq_withdraw_sol', 'pq_withdraw_token', 'pq_set_owner'].map((name) => sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8));
    const vault = vaultAt(Q);
    for (let i = 0; i < 300; i++) {
      const at = `seed 0x${SEED.toString(16)}, input ${i}`;
      const kind = below(4); // a post-quantum instruction's tag, or 8 random bytes
      const tag = kind < 3 ? pqTags[kind] : randomBytes(8);
      // Half the inputs are steered past the signature checks. Half of those carry arguments of the exact size, so the
      // decoder rebuilds a message and runs the LM-OTS check on a random signature of the LM-OTS type; the rest carry
      // arguments cut short or overlong.
      const steered = below(2) === 1;
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, steered || below(2) ? lmots.SIG_LEN : random(), true);
      const exact = (kind === 2 ? 1 + 32 * below(2) : 8) + lmots.N; // set_owner: Option<Pubkey>; the rest: u64
      const sizing = below(4);
      const args = sizing < 2 ? exact : sizing === 2 ? below(8) : below(exact + 9);
      const rest = randomBytes(steered ? lmots.SIG_LEN + args : below(1_601));
      if (steered) {
        new DataView(rest.buffer).setUint32(0, lmots.LMOTS_TYPE);
        rest[lmots.SIG_LEN] = below(2); // set_owner's Option tag (the amount's low byte otherwise)
      }
      const ix: SeenInstruction = {
        program: VAULT_PROGRAM,
        accounts: [VAULT, DEST, ...Array.from({ length: below(4) }, () => (below(2) ? OWNER : DEST))],
        data: new Uint8Array([...tag, ...length, ...rest]),
      };
      let found: unknown;
      expect(() => (found = signedByCurrentKey([ix], vault)), at).not.toThrow();
      expect(found, at).toBeNull();
    }
  });
});

/** xorshift32: the same seed gives the same numbers (unsigned 32-bit) on every run. */
function xorshift32(seed: number) {
  let x = seed | 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
}

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
