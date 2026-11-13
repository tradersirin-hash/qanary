/** Where a completed scan is counted: api/scan-count.ts, on this site. */
export const SCAN_COUNT_PATH = '/api/scan-count';

/** Adds one to the site's daily scan total. The request is an empty POST: no address, no cookie, and no Referer at all
 *  (the page's URL keeps the scanned address in its fragment, which a Referer never carries; sending none is the
 *  simplest guarantee). Only the production build sends it, and a failure is ignored, so counting can never break or
 *  slow a scan. */
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
