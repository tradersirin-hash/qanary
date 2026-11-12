// The canary watchdog's decisions, kept apart from its RPC calls in watchdog.mjs so that watchdog-logic.test.mjs can
// check them without a network.

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
 *  `page(before, limit)` is getSignaturesForAddress (newest first, at most 1000 a call); `read(signature)` is
 *  getTransaction, which returns null while the node cannot serve that transaction yet. */
export async function findSignature({ key, limit, page, read }) {
  let before;
  let listed = 0;
  let checked = 0;
  let complete = false;
  while (listed < limit && !complete) {
    const want = Math.min(1000, limit - listed);
    const signatures = await page(before, want);
    listed += signatures.length;
    // A short page means the history ends here.
    complete = signatures.length < want;
    for (const { signature } of signatures) {
      const transaction = await read(signature);
      if (!transaction) continue;
      checked++;
      if (signedBy(transaction, key)) return { signed: signature, listed, checked, complete };
    }
    before = signatures.at(-1)?.signature;
  }
  return { signed: null, listed, checked, complete };
}

/** One line for the report on how much of the canary key's history this run read. */
export function historyNote({ listed, checked, complete }) {
  return `read ${checked} of ${listed} transactions, ${complete ? 'the whole history' : 'the newest only'}`;
}

/** The status the alert step switches on, the most serious first:
 *  - 'tripped': the flag is set on-chain.
 *  - 'drained': the honeypot dropped, but the watchdog could not trip the canary.
 *  - 'signed': the canary key signed a transaction, though the honeypot balance does not show it (say, it was
 *    refilled). The program cannot take a signature as proof yet, so the flag stays untripped.
 *  - 'alive': none of these. */
export function watchStatus({ tripped, check, signed }) {
  if (tripped) return 'tripped';
  if (check === 'drop') return 'drained';
  if (signed) return 'signed';
  return 'alive';
}

/** A send that failed fails the run only while nothing is wrong (a forced check, or raising the baseline), so the
 *  owner hears about a broken fee payer. When an alert is due the run never fails, so the alert step still runs. */
export const failsRun = ({ status, error }) => !!error && status === 'alive';
