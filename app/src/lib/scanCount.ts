/** Where a completed scan is counted: api/scan-count.ts, on this site. */
export const SCAN_COUNT_PATH = '/api/scan-count';

/** Adds one to the site's daily scan total. The request is an empty POST: no address, no cookie, and no Referer
 *  (the page's own link holds the scanned address in ?a=). Only the production build sends it, and a failure is
 *  ignored, so counting can never break or slow a scan. */
export function countScan(send: typeof fetch = globalThis.fetch, enabled: boolean = import.meta.env.PROD): void {
  if (!enabled || typeof send !== 'function') return;
  try {
    send(SCAN_COUNT_PATH, { method: 'POST', keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(
      () => {},
    );
  } catch {
    // A browser that refuses the request at once (say, an extension blocking it) changes nothing for the scan.
  }
}
