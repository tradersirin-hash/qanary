// Vercel Function behind POST /api/scan-count: adds one to today's scan total (UTC day) in an Upstash Redis
// database, under the key scans:YYYY-MM-DD. The site sends one empty request per completed scan (src/lib/scanCount.ts).
// The request carries no address and the function stores nothing but the counter, so the total is all there is to
// read (in the Upstash console). Anyone can send the request, so read the total as approximate.
//
// Counting is off until the database is connected: set KV_REST_API_URL and KV_REST_API_TOKEN (the names Vercel's
// Upstash integration sets), or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. Until then, and whenever the
// database cannot be reached, the function still answers 204, so the site never waits on it or sees an error.

type Env = Record<string, string | undefined>;

/** The Redis key for the UTC day of `now`. */
export function dayKey(now: Date): string {
  return `scans:${now.toISOString().slice(0, 10)}`;
}

/** The Upstash REST endpoint and token, or null while counting is not set up. */
export function counterConfig(env: Env): { url: string; token: string } | null {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

/** Counts one scan. The request itself is not read: its body, headers and address play no part. */
export async function handleScanCount(env: Env, send: typeof fetch = fetch, now: Date = new Date()): Promise<Response> {
  const config = counterConfig(env);
  if (config) {
    try {
      await send(`${config.url}/incr/${dayKey(now)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // A lost count is acceptable; an error page is not.
    }
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

const env: Env = (globalThis as { process?: { env: Env } }).process?.env ?? {};

export function POST(): Promise<Response> {
  return handleScanCount(env);
}
