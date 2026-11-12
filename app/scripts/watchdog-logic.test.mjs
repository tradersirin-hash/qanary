import { describe, expect, it } from 'vitest';
import { decodeCanary, failsRun, findSignature, historyNote, honeypotCheck, signedBy, watchStatus } from './watchdog-logic.mjs';

const CANARY_KEY = '4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ';
const PAYER = 'Payer11111111111111111111111111111111111111';
const PROGRAM = 'HhrtGaEUk6Tar4cdCHkgTZj7jY5YXha4wjfdm8EteXRV';

/** A getTransaction 'json' response with these static account keys, the first `signers` of them signing. */
const tx = (accountKeys, signers) => ({ transaction: { message: { header: { numRequiredSignatures: signers }, accountKeys } } });

/** A fake history, newest first: `transactions[i]` is what getTransaction returns for signature `s${i}` (null: not readable yet).
 *  With `blockTimes`, each listed entry also carries `blockTimes[i]`. */
function chain(transactions, blockTimes) {
  const calls = { pages: [], reads: 0 };
  const signatures = transactions.map((_, i) => `s${i}`);
  return {
    calls,
    page: async (before, limit) => {
      calls.pages.push({ before, limit });
      const start = before === undefined ? 0 : signatures.indexOf(before) + 1;
      return signatures
        .slice(start, start + limit)
        .map((signature, i) => (blockTimes ? { signature, blockTime: blockTimes[start + i] } : { signature }));
    },
    read: async (signature) => {
      calls.reads++;
      return transactions[signatures.indexOf(signature)];
    },
  };
}

const deposit = tx([PAYER, CANARY_KEY, PROGRAM], 1);
const signedByCanary = tx([PAYER, CANARY_KEY, PROGRAM], 2);

// The lookback cutoff in the window tests, 2027-01-15T08:00:00Z: an entry from an hour later is inside, one a second
// earlier is not.
const SINCE = 1_800_000_000;
const IN = SINCE + 3600;
const OLD = SINCE - 1;

describe('decodeCanary', () => {
  it('reads the flag and the baseline at their offsets', () => {
    const tripped = Buffer.from(
      'c0d1d6c5571c5273010807060504030201cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc18171615141312112827262524232221fe',
      'hex',
    );
    expect(decodeCanary(tripped)).toEqual({ tripped: true, baseline: 0x1112131415161718n });
    const alive = Buffer.from('wNHWxVccUnMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACj4REAAAAAAKPhEQAAAAD/', 'base64');
    expect(decodeCanary(alive)).toEqual({ tripped: false, baseline: 300_000_000n });
    // A plain Uint8Array that starts inside a larger buffer reads the same.
    expect(decodeCanary(new Uint8Array([0xee, ...tripped]).subarray(1))).toEqual({ tripped: true, baseline: 0x1112131415161718n });
  });

  it('refuses data too short to hold the whole account', () => {
    expect(decodeCanary(new Uint8Array(65))).toBeNull();
    expect(decodeCanary(new Uint8Array(0))).toBeNull();
  });
});

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

describe('findSignature with a lookback window', () => {
  it('reads the whole window when it holds no more than the limit', async () => {
    const c = chain([...Array(5).fill(deposit), deposit, deposit], [...Array(5).fill(IN), OLD, OLD]);
    const found = await findSignature({ key: CANARY_KEY, limit: 10, since: SINCE, ...c });
    expect(found).toEqual({ signed: null, listed: 5, checked: 5, complete: true, gap: false });
    expect(c.calls.pages).toEqual([{ before: undefined, limit: 11 }]);
    expect(c.calls.reads).toBe(5);
    expect(historyNote({ ...found, since: SINCE, limit: 10 })).toBe('read 5 of 5 transactions since 2027-01-15T08:00:00Z');
  });

  it('reports a gap when the window holds more than the limit and none of those read was signed', async () => {
    const c = chain(Array(5).fill(deposit), Array(5).fill(IN));
    const found = await findSignature({ key: CANARY_KEY, limit: 3, since: SINCE, ...c });
    expect(found).toEqual({ signed: null, listed: 4, checked: 3, complete: false, gap: true });
    // One entry past the limit is listed to see that the window holds more, but never read.
    expect(c.calls.pages).toEqual([{ before: undefined, limit: 4 }]);
    expect(c.calls.reads).toBe(3);
    expect(historyNote({ ...found, since: SINCE, limit: 3 })).toBe('more than 3 transactions since 2027-01-15T08:00:00Z; read the newest 3');
  });

  it('finds a signature in a window that holds more than the limit', async () => {
    const c = chain([deposit, signedByCanary, deposit, deposit, deposit], Array(5).fill(IN));
    const found = await findSignature({ key: CANARY_KEY, limit: 3, since: SINCE, ...c });
    expect(found).toMatchObject({ signed: 's1', checked: 2, gap: false });
    expect(c.calls.reads).toBe(2);
  });

  it('stops listing at the first entry older than the window, and never reads it', async () => {
    const c = chain([deposit, signedByCanary, deposit, deposit, deposit], [IN, OLD, OLD, OLD, OLD]);
    const found = await findSignature({ key: CANARY_KEY, limit: 3, since: SINCE, ...c });
    expect(found).toEqual({ signed: null, listed: 1, checked: 1, complete: true, gap: false });
    // The page was full, so only the old entry ended the listing.
    expect(c.calls.pages).toEqual([{ before: undefined, limit: 4 }]);
    expect(c.calls.reads).toBe(1);
  });

  it('counts an entry at the cutoff, or with no block time, as inside the window', async () => {
    const c = chain([deposit, deposit, signedByCanary, deposit], [IN, null, SINCE, OLD]);
    const found = await findSignature({ key: CANARY_KEY, limit: 10, since: SINCE, ...c });
    expect(found.signed).toBe('s2');
    expect(c.calls.reads).toBe(3);
    const unknown = await findSignature({ key: CANARY_KEY, limit: 2, since: SINCE, ...chain(Array(3).fill(deposit), Array(3).fill(null)) });
    expect(unknown).toEqual({ signed: null, listed: 3, checked: 2, complete: false, gap: true });
  });

  it('pages 1000 at a time up to one entry past the limit', async () => {
    const c = chain(Array(1600).fill(deposit), Array(1600).fill(IN));
    const found = await findSignature({ key: CANARY_KEY, limit: 1500, since: SINCE, ...c });
    expect(found).toEqual({ signed: null, listed: 1501, checked: 1500, complete: false, gap: true });
    expect(c.calls.pages).toEqual([
      { before: undefined, limit: 1000 },
      { before: 's999', limit: 501 },
    ]);
  });

  it('does not report a gap for a short window whose transactions the node cannot serve yet', async () => {
    const found = await findSignature({ key: CANARY_KEY, limit: 3, since: SINCE, ...chain([null, deposit], [IN, IN]) });
    expect(found).toEqual({ signed: null, listed: 2, checked: 1, complete: true, gap: false });
    expect(historyNote({ ...found, since: SINCE, limit: 3 })).toBe('read 1 of 2 transactions since 2027-01-15T08:00:00Z');
  });

  it('ignores block times without a window, as before', async () => {
    const c = chain(Array(6).fill(deposit), Array(6).fill(OLD));
    const found = await findSignature({ key: CANARY_KEY, limit: 5, ...c });
    expect(found).toEqual({ signed: null, listed: 5, checked: 5, complete: false });
    expect(found).not.toHaveProperty('gap');
    expect(c.calls.pages).toEqual([{ before: undefined, limit: 5 }]);
    expect(historyNote(found)).toBe('read 5 of 5 transactions, the newest only');
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

  it('reports a history gap only when nothing more serious is found', () => {
    expect(watchStatus({ tripped: false, check: null, signed: false, gap: true })).toBe('history_gap');
    expect(watchStatus({ tripped: false, check: 'surplus', signed: false, gap: true })).toBe('history_gap');
    expect(watchStatus({ tripped: false, check: null, signed: true, gap: true })).toBe('signed');
    expect(watchStatus({ tripped: false, check: 'drop', signed: false, gap: true })).toBe('drained');
    expect(watchStatus({ tripped: true, check: null, signed: false, gap: true })).toBe('tripped');
    expect(watchStatus({ tripped: false, check: null, signed: false, gap: false })).toBe('alive');
  });
});

describe('failsRun', () => {
  it('fails a run whose send failed only while no alert is due', () => {
    expect(failsRun({ status: 'alive', error: 'no WATCHDOG_KEYPAIR', historyError: '' })).toBe(true);
    expect(failsRun({ status: 'alive', error: '', historyError: '' })).toBe(false);
    for (const status of ['drained', 'signed', 'tripped']) expect(failsRun({ status, error: 'airdrop failed', historyError: '' }), status).toBe(false);
  });

  it('never lets an unreadable history pass for alive', () => {
    expect(failsRun({ status: 'alive', error: '', historyError: 'HTTP error (429)' })).toBe(true);
    // A drop the watchdog could not trip still opens its issue, which says the history was not read.
    expect(failsRun({ status: 'drained', error: 'airdrop failed', historyError: 'HTTP error (429)' })).toBe(false);
  });

  it('lets a history gap open its issue instead of failing the run', () => {
    expect(failsRun({ status: 'history_gap', error: 'no WATCHDOG_KEYPAIR', historyError: '' })).toBe(false);
  });
});
