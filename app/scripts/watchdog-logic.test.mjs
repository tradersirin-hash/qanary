import { describe, expect, it } from 'vitest';
import { failsRun, findSignature, historyNote, honeypotCheck, signedBy, watchStatus } from './watchdog-logic.mjs';

const CANARY_KEY = '4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ';
const PAYER = 'Payer11111111111111111111111111111111111111';
const PROGRAM = 'HhrtGaEUk6Tar4cdCHkgTZj7jY5YXha4wjfdm8EteXRV';

/** A getTransaction 'json' response with these static account keys, the first `signers` of them signing. */
const tx = (accountKeys, signers) => ({ transaction: { message: { header: { numRequiredSignatures: signers }, accountKeys } } });

/** A fake history, newest first: `transactions[i]` is what getTransaction returns for signature `s${i}` (null: not readable yet). */
function chain(transactions) {
  const calls = { pages: [], reads: 0 };
  const signatures = transactions.map((_, i) => `s${i}`);
  return {
    calls,
    page: async (before, limit) => {
      calls.pages.push({ before, limit });
      const start = before === undefined ? 0 : signatures.indexOf(before) + 1;
      return signatures.slice(start, start + limit).map((signature) => ({ signature }));
    },
    read: async (signature) => {
      calls.reads++;
      return transactions[signatures.indexOf(signature)];
    },
  };
}

const deposit = tx([PAYER, CANARY_KEY, PROGRAM], 1);
const signedByCanary = tx([PAYER, CANARY_KEY, PROGRAM], 2);

describe('honeypotCheck', () => {
  it('trips on a drop, raises the baseline on a surplus, and sends nothing when they match', () => {
    expect(honeypotCheck({ balance: 299_999_999n, baseline: 300_000_000n })).toBe('drop');
    expect(honeypotCheck({ balance: 300_000_001n, baseline: 300_000_000n })).toBe('surplus');
    expect(honeypotCheck({ balance: 300_000_000n, baseline: 300_000_000n })).toBeNull();
  });

  it('sends a forced check only when there is nothing else to send', () => {
    expect(honeypotCheck({ balance: 300_000_000n, baseline: 300_000_000n }, true)).toBe('forced');
    expect(honeypotCheck({ balance: 0n, baseline: 300_000_000n }, true)).toBe('drop');
    expect(honeypotCheck({ balance: 400_000_000n, baseline: 300_000_000n }, true)).toBe('surplus');
  });
});

describe('signedBy', () => {
  it('counts only the signer slots of the static account keys', () => {
    expect(signedBy(signedByCanary, CANARY_KEY)).toBe(true);
    // Read-only or writable, a key past numRequiredSignatures only appears in the transaction.
    expect(signedBy(deposit, CANARY_KEY)).toBe(false);
    expect(signedBy(tx([CANARY_KEY, PAYER], 1), CANARY_KEY)).toBe(true);
    expect(signedBy(tx([PAYER], 1), CANARY_KEY)).toBe(false);
  });
});

describe('findSignature', () => {
  it('reads the whole history when it is short, and finds nothing in plain deposits', async () => {
    const c = chain([deposit, deposit, deposit]);
    const found = await findSignature({ key: CANARY_KEY, limit: 100, ...c });
    expect(found).toEqual({ signed: null, listed: 3, checked: 3, complete: true });
    expect(c.calls.pages).toEqual([{ before: undefined, limit: 100 }]);
    expect(historyNote(found)).toBe('read 3 of 3 transactions, the whole history');
  });

  it('finds a signature even when later deposits refilled the honeypot, and stops reading there', async () => {
    const c = chain([deposit, deposit, signedByCanary, deposit]);
    const found = await findSignature({ key: CANARY_KEY, limit: 100, ...c });
    expect(found.signed).toBe('s2');
    expect(c.calls.reads).toBe(3);
  });

  it('reads no more than the limit, and says the older history was not read', async () => {
    const c = chain([...Array(5).fill(deposit), signedByCanary]);
    const found = await findSignature({ key: CANARY_KEY, limit: 5, ...c });
    expect(found).toEqual({ signed: null, listed: 5, checked: 5, complete: false });
    expect(historyNote(found)).toBe('read 5 of 5 transactions, the newest only');
  });

  it('pages 1000 at a time from the oldest signature it has seen', async () => {
    const c = chain([...Array(1500).fill(deposit), signedByCanary]);
    const found = await findSignature({ key: CANARY_KEY, limit: 2000, ...c });
    expect(found.signed).toBe('s1500');
    expect(c.calls.pages).toEqual([
      { before: undefined, limit: 1000 },
      { before: 's999', limit: 1000 },
    ]);
  });

  it('skips a transaction the node cannot serve yet without counting it as read', async () => {
    const found = await findSignature({ key: CANARY_KEY, limit: 100, ...chain([null, deposit]) });
    expect(found).toEqual({ signed: null, listed: 2, checked: 1, complete: true });
  });

  it('handles a key with no history', async () => {
    const found = await findSignature({ key: CANARY_KEY, limit: 100, ...chain([]) });
    expect(found).toEqual({ signed: null, listed: 0, checked: 0, complete: true });
  });
});

describe('watchStatus', () => {
  it('ranks a tripped flag first, then a drop the watchdog could not trip, then a signature', () => {
    expect(watchStatus({ tripped: true, check: 'drop', signed: true })).toBe('tripped');
    expect(watchStatus({ tripped: false, check: 'drop', signed: true })).toBe('drained');
    expect(watchStatus({ tripped: false, check: 'surplus', signed: true })).toBe('signed');
    expect(watchStatus({ tripped: false, check: null, signed: true })).toBe('signed');
    expect(watchStatus({ tripped: false, check: 'surplus', signed: false })).toBe('alive');
    expect(watchStatus({ tripped: false, check: null, signed: false })).toBe('alive');
  });
});

describe('failsRun', () => {
  it('fails a run whose send failed only while no alert is due', () => {
    expect(failsRun({ status: 'alive', error: 'no WATCHDOG_KEYPAIR' })).toBe(true);
    expect(failsRun({ status: 'alive', error: '' })).toBe(false);
    for (const status of ['drained', 'signed', 'tripped']) expect(failsRun({ status, error: 'airdrop failed' }), status).toBe(false);
  });
});
