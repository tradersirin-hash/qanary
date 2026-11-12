import { address, getAddressDecoder, type Address } from '@solana/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOUNTY_PROGRAM, CANARY_KEY, canaryAddress, fetchCanary, fetchVault, VAULT_PROGRAM } from './qanary';

/** Accounts as the RPC serves them, by address. `reply`, when set, replaces the whole getMultipleAccounts answer. */
const chain = vi.hoisted(() => ({ accounts: new Map<string, unknown>(), reply: null as unknown[] | null }));
/** Rent exemption as the runtime computes it: 6,960 lamports a byte, 128 bytes of account overhead included. */
const rent = vi.hoisted(() => (space: bigint | number) => (BigInt(space) + 128n) * 6_960n);

vi.mock('@solana/kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/kit')>()),
  createSolanaRpc: () => ({
    getAccountInfo: (a: string) => ({ send: async () => ({ value: chain.accounts.get(a) ?? null }) }),
    getMultipleAccounts: (addresses: string[]) => ({
      send: async () => ({ value: chain.reply ?? addresses.map((a) => chain.accounts.get(a) ?? null) }),
    }),
    getMinimumBalanceForRentExemption: (space: bigint) => ({ send: async () => rent(space) }),
  }),
}));

// The account bytes exactly as the programs serialize them. The onchain tests assert the same hex
// (qanary_bounty/tests/test_bounty.rs and qanary_vault/tests/test_client_vectors.rs), so a layout change breaks both.
/** Tripped at slot 0x0102030405060708 by a claim to 32 bytes of 0xcc, baseline 0x1112131415161718, total funded
 *  0x2122232425262728, bump 0xfe. */
const CANARY_VECTOR =
  'c0d1d6c5571c5273010807060504030201cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc18171615141312112827262524232221fe';
/** The devnet canary, read on 2026-11-12 at slot 521566543: alive, never claimed, 0.3 SOL baseline and funding. */
const DEVNET_CANARY = 'wNHWxVccUnMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACj4REAAAAAAKPhEQAAAAD/';
/** Id 'qanary-layout-01', genesis key 24 x 0x11, key 24 x 0x22, nonce 0x01020304, owner 32 x 0xdd, bump 0xfe. */
const VAULT_SOME =
  'd308e82b0298757771616e6172792d6c61796f75742d30311111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222220403020101ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddfe';
/** The same vault without an owner: the bump follows the None tag and the space an owner would take stays zero. */
const VAULT_NONE =
  'd308e82b0298757771616e6172792d6c61796f75742d30311111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222220403020100fe0000000000000000000000000000000000000000000000000000000000000000';

const CANARY_RENT = rent(66);
const VAULT_RENT = rent(110);

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const fill = (length: number, byte: number) => new Uint8Array(length).fill(byte);
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

/** An account as getAccountInfo and getMultipleAccounts return it with base64 encoding. */
const account = (owner: Address, lamports: bigint, data: Uint8Array) => ({
  owner,
  lamports,
  executable: false,
  rentEpoch: 0n,
  space: BigInt(data.length),
  data: [btoa(String.fromCharCode(...data)), 'base64'],
});

const CANARY = await canaryAddress();
const VAULT = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');

afterEach(() => {
  chain.accounts.clear();
  chain.reply = null;
});

describe('fetchCanary', () => {
  const canaryWith = (data: Uint8Array, lamports = CANARY_RENT + 500_000_000n, owner: Address = BOUNTY_PROGRAM) =>
    chain.accounts.set(CANARY, account(owner, lamports, data));
  const honeypotWith = (lamports: bigint) => chain.accounts.set(CANARY_KEY, account(SYSTEM_PROGRAM, lamports, new Uint8Array()));

  it('decodes every field of the bounty program layout', async () => {
    canaryWith(hex(CANARY_VECTOR), CANARY_RENT + 123_456n);
    honeypotWith(250_000_000n);
    expect(await fetchCanary('devnet')).toEqual({
      address: CANARY,
      tripped: true,
      trippedSlot: 0x0102030405060708n,
      claimer: getAddressDecoder().decode(fill(32, 0xcc)),
      honeypotBaseline: 0x1112131415161718n,
      honeypotLamports: 250_000_000n,
      totalFunded: 0x2122232425262728n,
      pool: 123_456n,
    });
  });

  it('reads the devnet canary as alive and unclaimed', async () => {
    canaryWith(Uint8Array.from(atob(DEVNET_CANARY), (c) => c.charCodeAt(0)), CANARY_RENT + 300_000_000n);
    honeypotWith(300_000_000n);
    expect(await fetchCanary('devnet')).toMatchObject({
      tripped: false,
      trippedSlot: 0n,
      claimer: null,
      honeypotBaseline: 300_000_000n,
      honeypotLamports: 300_000_000n,
      totalFunded: 300_000_000n,
      pool: 300_000_000n,
    });
  });

  it('reads a honeypot that does not exist as holding nothing', async () => {
    canaryWith(hex(CANARY_VECTOR));
    expect((await fetchCanary('devnet'))?.honeypotLamports).toBe(0n);
  });

  it('reads nothing without the account, with another owner or with data too short for the layout', async () => {
    honeypotWith(300_000_000n);
    expect(await fetchCanary('devnet'), 'no account').toBeNull();
    canaryWith(hex(CANARY_VECTOR), CANARY_RENT, VAULT_PROGRAM);
    expect(await fetchCanary('devnet'), 'another owner').toBeNull();
    canaryWith(hex(CANARY_VECTOR).slice(0, 65));
    expect(await fetchCanary('devnet'), '65 bytes').toBeNull();
  });

  it('shows an empty pool at or below rent', async () => {
    for (const lamports of [CANARY_RENT, CANARY_RENT - 1n]) {
      canaryWith(hex(CANARY_VECTOR), lamports);
      expect((await fetchCanary('devnet'))?.pool).toBe(0n);
    }
  });

  it('throws on a reply without both accounts instead of reading the honeypot as drained', async () => {
    chain.reply = [account(BOUNTY_PROGRAM, CANARY_RENT, hex(CANARY_VECTOR))];
    await expect(fetchCanary('devnet')).rejects.toThrow('The RPC returned an incomplete canary read.');
  });
});

describe('fetchVault', () => {
  const vaultWith = (data: Uint8Array, lamports = VAULT_RENT + 2_000_000n, owner: Address = VAULT_PROGRAM) =>
    chain.accounts.set(VAULT, account(owner, lamports, data));

  it('decodes every field of the vault program layout', async () => {
    vaultWith(hex(VAULT_SOME));
    expect(await fetchVault(VAULT)).toEqual({
      address: VAULT,
      id: new TextEncoder().encode('qanary-layout-01'),
      genesisKey: fill(24, 0x11),
      key: fill(24, 0x22),
      nonce: 16909060,
      owner: getAddressDecoder().decode(fill(32, 0xdd)),
      lamports: VAULT_RENT + 2_000_000n,
      spendable: 2_000_000n,
    });
  });

  it('reads a vault without an owner', async () => {
    vaultWith(hex(VAULT_NONE));
    expect((await fetchVault(VAULT))?.owner).toBeNull();
  });

  it('reads nothing but the exact vault layout owned by the vault program', async () => {
    expect(await fetchVault(VAULT), 'no account').toBeNull();
    vaultWith(hex(VAULT_SOME).slice(0, 109));
    expect(await fetchVault(VAULT), '109 bytes').toBeNull();
    vaultWith(Uint8Array.of(...hex(VAULT_SOME), 0));
    expect(await fetchVault(VAULT), '111 bytes').toBeNull();
    vaultWith(hex(VAULT_SOME), VAULT_RENT, BOUNTY_PROGRAM);
    expect(await fetchVault(VAULT), 'another owner').toBeNull();
  });

  it('has nothing spendable at rent', async () => {
    vaultWith(hex(VAULT_NONE), VAULT_RENT);
    expect((await fetchVault(VAULT))?.spendable).toBe(0n);
  });
});
