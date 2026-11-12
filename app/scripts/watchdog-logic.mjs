// The canary watchdog's decisions, kept apart from its RPC calls in watchdog.mjs so that watchdog-logic.test.mjs can
// check them without a network.

/** The canary account's data: disc 8 | tripped 1 | tripped_slot 8 | claimer 32 | honeypot_baseline 8 | total_funded 8 |
 *  bump 1. Returns null when `bytes` (a Uint8Array; a Buffer works) is too short to hold all of it. */
export function decodeCanary(bytes) {
  if (bytes.length < 66) return null;
  return {
    tripped: bytes[8] === 1,
    baseline: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(49, true),
  };
}

/** Why the watchdog sends check_honeypot to a canary that is not tripped, or null when it has no reason to.
 *  - 'drop': the honeypot fell below its baseline. Only the canary key can cause that, so the program trips the canary.
 *  - 'surplus': the honeypot holds more than its baseline (a plain transfer, not fund_honeypot). The program raises the
 *    baseline to the balance; otherwise a key-breaker could take the surplus back down to the old baseline unnoticed.
 *  - 'forced': FORCE_CHECK with nothing to fix. It only tests the fee payer.
 *  A wrong guess is harmless: the program trips only on a real drop, and otherwise just records the balance. */
export function honeypotCheck({ balance, baseline }, force = false) {
  if (balance < baseline) return 'drop';
  if (balance > baseline) return 'surplus';
  return force ? 'forced' : null;
}

/** True if `key` signed the transaction (a getTransaction response with encoding 'json'). The signers are the first
 *  header.numRequiredSignatures static account keys; an address lookup table can never supply a signer. */
export function signedBy(transaction, key) {
  const { header, accountKeys } = transaction.transaction.message;
  return accountKeys.slice(0, Number(header.numRequiredSignatures)).includes(key);
}

/** Reads the transactions that mention `key`, newest first, at most `limit` of them, and stops at the first one `key`
 *  signed. Failed transactions count: a block only includes a transaction whose signatures are valid.
 *  `page(before, limit)` is getSignaturesForAddress (newest first, at most 1000 a call), with entries
 *  { signature, blockTime } (blockTime in unix seconds, or null when the node does not know it); `read(signature)` is
 *  getTransaction, which returns null while the node cannot serve that transaction yet.
 *
 *  Without `since`, it reads the newest `limit` and `complete` says whether that was the whole history. With `since`
 *  (unix seconds) it reads only the window back to that time, where a null blockTime counts as inside: it lists one
 *  entry more than `limit` to tell a window that holds more than `limit` transactions from one that holds exactly
 *  `limit`, `complete` says whether the listing covered the whole window, and `gap` is true when no signature was
 *  found and the window holds more than `limit` transactions, so one the key signed could be among those not read. */
export async function findSignature({ key, limit, since, page, read }) {
  const target = since === undefined ? limit : limit + 1;
  let before;
  let listed = 0;
  let checked = 0;
  let complete = false;
  const result = (signed) => {
    const found = { signed, listed, checked, complete };
    return since === undefined ? found : { ...found, gap: !signed && listed > limit };
  };
  while (listed < target && !complete) {
    const want = Math.min(1000, target - listed);
    const signatures = await page(before, want);
    // Newest first, so the window ends at the first entry older than `since`.
    const end = since === undefined ? -1 : signatures.findIndex(({ blockTime }) => blockTime != null && blockTime < since);
    const inside = end === -1 ? signatures : signatures.slice(0, end);
    // Every entry inside is read, up to `limit` in all: the one listed past it only tells that the window holds more.
    const toRead = inside.slice(0, Math.max(0, limit - listed));
    listed += inside.length;
    // A short page means the history ends here; an entry older than `since` means the window does.
    complete = signatures.length < want || end !== -1;
    for (const { signature } of toRead) {
      const transaction = await read(signature);
      if (!transaction) continue;
      checked++;
      if (signedBy(transaction, key)) return result(signature);
    }
    before = signatures.at(-1)?.signature;
  }
  return result(null);
}

/** One line for the report on how much of the canary key's history this run read. With `since`, `limit` is the
 *  findSignature limit. */
export function historyNote({ listed, checked, complete, gap, since, limit }) {
  if (since === undefined) return `read ${checked} of ${listed} transactions, ${complete ? 'the whole history' : 'the newest only'}`;
  const from = new Date(since * 1000).toISOString().replace('.000Z', 'Z');
  return gap ? `more than ${limit} transactions since ${from}; read the newest ${checked}` : `read ${checked} of ${listed} transactions since ${from}`;
}

/** The status the alert step switches on, the most serious first:
 *  - 'tripped': the flag is set on-chain.
 *  - 'drained': the honeypot dropped, but the watchdog could not trip the canary.
 *  - 'signed': the canary key signed a transaction, though the honeypot balance does not show it (say, it was
 *    refilled). The program cannot take a signature as proof yet, so the flag stays untripped.
 *  - 'history_gap': the lookback window holds more transactions than the watchdog reads, so it cannot tell that the
 *    key signed none of them. Dust transfers to the key can cause it; it says "could not verify", not "broken".
 *  - 'alive': none of these. */
export function watchStatus({ tripped, check, signed, gap }) {
  if (tripped) return 'tripped';
  if (check === 'drop') return 'drained';
  if (signed) return 'signed';
  if (gap) return 'history_gap';
  return 'alive';
}

/** A failed send (a forced check, or raising the baseline) or an unreadable history fails the run only while nothing
 *  is wrong, so the owner hears about a broken fee payer or RPC instead of a run that passes for alive. When an alert
 *  is due the run never fails, so the alert step still runs. */
export const failsRun = ({ status, error, historyError }) => status === 'alive' && (!!error || !!historyError);
