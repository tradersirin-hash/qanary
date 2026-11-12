import { address, getBase58Decoder } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaybeLanded, send, transferIx, type SendStep } from './qanary';
import type { StandardWallet, WalletAccount } from './wallet';

vi.mock('./wallet', () => ({ signAndSend: vi.fn(async () => new Uint8Array(64).fill(7)) }));

/** The RPC's answers while a sent transaction is confirmed, one per call. An entry of 'error' makes that call fail;
 *  `errors` keeps what was thrown. */
const chain = vi.hoisted(() => ({ statuses: [] as unknown[], heights: [] as unknown[], errors: [] as Error[] }));

vi.mock('@solana/kit', async (importOriginal) => {
  const next = (queue: unknown[]) => {
    if (queue.length === 0) throw new Error('No RPC answer left in the queue');
    const entry = queue.shift();
    if (entry !== 'error') return entry;
    const e = new Error(`fetch failed (${chain.errors.length + 1})`);
    chain.errors.push(e);
    throw e;
  };
  return {
    ...(await importOriginal<typeof import('@solana/kit')>()),
    createSolanaRpc: () => ({
      getLatestBlockhash: () => ({
        send: async () => ({ value: { blockhash: '74V4eZpZtkqi4H4TSxg7B4gz2tYrpe39ejyyV9LQx4Gv', lastValidBlockHeight: 100n } }),
      }),
      getSignatureStatuses: () => ({ send: async () => ({ value: [next(chain.statuses)] }) }),
      getBlockHeight: () => ({ send: async () => next(chain.heights) }),
    }),
  };
});

const PAYER = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const DEST = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
/** The signature the mocked wallet returns, as send() reports it. */
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const wallet: StandardWallet = { name: 'Test Wallet', icon: '', chains: ['solana:devnet'], accounts: [], features: {} };
const account: WalletAccount = { address: PAYER, publicKey: new Uint8Array(32), chains: ['solana:devnet'], features: [] };

const status = (confirmationStatus: 'processed' | 'confirmed' | 'finalized', err: unknown = null) => ({ slot: 1n, confirmations: null, confirmationStatus, err });

/** Sends one transfer against the queued answers, moving the clock a second per poll until send() settles. Every
 *  queued answer must be used: a poll more or fewer than expected fails the test. */
async function sendWith(statuses: unknown[], heights: unknown[] = []) {
  Object.assign(chain, { statuses: [...statuses], heights: [...heights], errors: [] });
  const steps: SendStep[] = [];
  let signature: string | undefined;
  let error: unknown;
  let settled = false;
  void send('devnet', wallet, account, [transferIx(PAYER, DEST, 1_000n)], (s) => steps.push(s))
    .then(
      (s) => (signature = s),
      (e: unknown) => (error = e),
    )
    .finally(() => (settled = true));
  for (let polls = 0; !settled && polls < 20; polls++) await vi.advanceTimersByTimeAsync(1000);
  expect(settled, 'send() settled').toBe(true);
  expect(chain.statuses, 'status answers left').toEqual([]);
  expect(chain.heights, 'height answers left').toEqual([]);
  return { signature, error, steps };
}

describe('send', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('returns the signature once the transaction is confirmed, not at processed', async () => {
    const { signature, error, steps } = await sendWith([null, status('processed'), status('confirmed')], [90n, 95n]);
    expect(error).toBeUndefined();
    expect(signature).toBe(SIGNATURE);
    expect(steps).toEqual(['approve', 'confirm']);
  });

  it('counts finalized as landed', async () => {
    expect((await sendWith([status('finalized')])).signature).toBe(SIGNATURE);
  });

  it('reports MaybeLanded with the signature when the blockhash expires before the transaction is seen', async () => {
    const { error } = await sendWith([null], [101n]);
    expect(error).toBeInstanceOf(MaybeLanded);
    expect((error as MaybeLanded).signature).toBe(SIGNATURE);
    expect((error as MaybeLanded).cause).toBeUndefined();
  });

  it('reports MaybeLanded when the transaction is still only processed at expiry', async () => {
    const { error } = await sendWith([status('processed')], [101n]);
    expect(error).toBeInstanceOf(MaybeLanded);
    expect((error as MaybeLanded).signature).toBe(SIGNATURE);
  });

  it('reports a transaction that landed with an error as failed, never as MaybeLanded', async () => {
    const { error } = await sendWith([status('confirmed', { InstructionError: [1, { Custom: 6000n }] })]);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MaybeLanded);
    expect((error as Error).message).toMatch(/^Transaction failed:/);
    expect((error as Error).message).toContain('6000');
  });

  it('ends three RPC errors in a row in MaybeLanded, with the last error as cause, not in a bare network error', async () => {
    // Either read: the status, or the block height of a transaction not seen yet.
    for (const [statuses, heights] of [
      [['error', 'error', 'error'], []],
      [[null], ['error', 'error', 'error']],
    ]) {
      const { error } = await sendWith(statuses, heights);
      expect(error).toBeInstanceOf(MaybeLanded);
      expect((error as MaybeLanded).signature).toBe(SIGNATURE);
      expect(chain.errors).toHaveLength(3);
      expect((error as MaybeLanded).cause).toBe(chain.errors[2]);
    }
  });

  it('resolves after an RPC error once the transaction is confirmed', async () => {
    expect((await sendWith(['error', status('confirmed')])).signature).toBe(SIGNATURE);
  });

  it('starts counting again after every successful read, so errors that are not in a row never add up', async () => {
    const { signature } = await sendWith(['error', 'error', null, 'error', 'error', status('confirmed')], ['error', 'error', 90n]);
    expect(signature).toBe(SIGNATURE);
    expect(chain.errors).toHaveLength(6);
  });
});
