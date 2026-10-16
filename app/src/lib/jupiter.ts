// Jupiter's public APIs: wallet holdings, USD prices and token symbols. Every call fails soft.
const JUP = 'https://lite-api.jup.ag';
const PRICE_BATCH = 50;
/** The keyless API allows 5 requests per 10 seconds per IP, shared by every endpoint. Holdings, three price
 *  batches and the symbol lookup fit in one window, so very large wallets are priced partially. */
const MAX_PRICED_MINTS = 3 * PRICE_BATCH;
const WINDOW_MS = 10_000;
const TIMEOUT_MS = 15_000;
/** A scan's Jupiter calls, waits and retries included, end within this budget, so a rate-limited scan never hangs. */
const BUDGET_MS = 25_000;
/** Pricing stops this long before the deadline, so the symbol lookup that flags spam tokens still gets its turn. */
const SYMBOLS_RESERVE_MS = 5_000;
/** Waits before retrying a 429, a 5xx or a network error. */
const RETRY_MS = [500, 1000, 2000];
/** Prices and symbols are reused for a minute, so scanning again does not spend the rate limit twice. */
const CACHE_MS = 60_000;

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Priced first so a capped or rate-limited lookup still covers SOL and the usual large holdings. The rest go by
 *  amount, where spam with huge supplies comes first and high-priced tokens (BTC, ETH, staked SOL) come last. */
const MAJOR_MINTS = [
  WSOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', // EURC
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', // cbBTC
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC (Portal)
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH (Portal)
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', // JupSOL
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', // INF
  'Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ', // dSOL
  'Bybit2vBJGhPF52GBdNaQfUJ6ZpThSgHBobjWZpLPb4B', // bbSOL
  'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A', // hSOL
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4', // JLP
  'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', // PUMP
  'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', // RENDER
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
  'Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs', // GRASS
  '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', // PENGU
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', // TRUMP
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', // JTO
  'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', // KMNO
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', // FARTCOIN
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', // ORCA
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', // W
];

/** The deadline (ms) for one scan's Jupiter calls. */
export const jupiterDeadline = () => Date.now() + BUDGET_MS;

export type Holdings = { lamports: bigint; tokens: { mint: string; amount: bigint; uiAmount: number }[] };

type HoldingsResponse = {
  amount: string;
  tokens: Record<string, { amount: string; uiAmount: number; excludeFromNetWorth?: boolean }[]>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Until when (local ms) the current rate-limit window is used up, from the headers Jupiter exposes to browsers. */
let windowFullUntil = 0;

/** Time until the window reported in `res` resets, capped at one window in case the clocks disagree. A reset more
 *  than a second in the past means the local clock runs ahead of Jupiter's, so a whole window is assumed. */
function untilReset(res: Response): number {
  const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
  if (!(reset > 0)) return 0;
  const left = reset - Date.now();
  return (left < -1000 ? WINDOW_MS : Math.min(Math.max(left, 0), WINDOW_MS)) + 250;
}

/** GET that waits out a used-up rate window and retries 429s, 5xx and network errors with backoff, all before
 *  `deadline` (ms). Returns null if that fails or on any other error. */
async function getJson<T>(url: string, deadline: number): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const pause = windowFullUntil - Date.now();
    if (pause > 0) {
      if (Date.now() + pause >= deadline) return null;
      await sleep(pause);
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    let wait = RETRY_MS[attempt];
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, left)) });
      if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') windowFullUntil = Date.now() + untilReset(res);
      if (res.ok) return (await res.json()) as T;
      if (res.status !== 429 && res.status < 500) return null;
      if (wait !== undefined) wait = Math.max(wait, Number(res.headers.get('Retry-After')) * 1000 || 0);
    } catch {
      // Network error, timeout or a broken body: retried like a 429.
    }
    if (wait === undefined || Date.now() + wait >= deadline) return null;
    await sleep(wait);
  }
}

/** SOL and token balances of a wallet, merged per mint. Returns null if Jupiter is unreachable. */
export async function fetchHoldings(owner: string, deadline: number): Promise<Holdings | null> {
  const json = await getJson<HoldingsResponse>(`${JUP}/ultra/v1/holdings/${owner}`, deadline);
  if (!json) return null;
  const tokens: Holdings['tokens'] = [];
  for (const [mint, accounts] of Object.entries(json.tokens ?? {})) {
    let raw = 0n;
    let ui = 0;
    for (const acc of accounts) {
      if (acc.excludeFromNetWorth) continue;
      raw += BigInt(acc.amount);
      ui += acc.uiAmount;
    }
    if (raw > 0n) tokens.push({ mint, amount: raw, uiAmount: ui });
  }
  return { lamports: BigInt(json.amount ?? '0'), tokens };
}

/** `partial` is true when some mints were skipped (cap) or not fetched; `failed` when a lookup still failed after retries. */
export type Prices = { prices: Record<string, number>; partial: boolean; failed: boolean };

const priceCache = new Map<string, { usd?: number; at: number }>();

/** USD prices: SOL and the usual large holdings first, then the rest in the given order (largest first). */
export async function fetchUsdPrices(mints: string[], deadline: number): Promise<Prices> {
  const unique = [...new Set(mints)];
  const ordered = [...MAJOR_MINTS.filter((m) => unique.includes(m)), ...unique.filter((m) => !MAJOR_MINTS.includes(m))];
  const capped = ordered.slice(0, MAX_PRICED_MINTS);
  const prices: Record<string, number> = {};
  const now = Date.now();
  const missing = capped.filter((m) => {
    const hit = priceCache.get(m);
    if (!hit || now - hit.at > CACHE_MS) return true;
    if (hit.usd !== undefined) prices[m] = hit.usd;
    return false;
  });

  // One batch at a time, most important first, so a rate limit costs the long tail rather than the large holdings.
  let failed = false;
  for (let i = 0; i < missing.length; i += PRICE_BATCH) {
    const batch = missing.slice(i, i + PRICE_BATCH);
    const json = await getJson<Record<string, { usdPrice?: number } | null>>(
      `${JUP}/price/v3?ids=${batch.join(',')}`,
      deadline - SYMBOLS_RESERVE_MS,
    );
    if (!json) {
      failed = true;
      break;
    }
    for (const mint of batch) {
      const entry = json[mint];
      const usd = entry && typeof entry.usdPrice === 'number' ? entry.usdPrice : undefined;
      priceCache.set(mint, { usd, at: Date.now() });
      if (usd !== undefined) prices[mint] = usd;
    }
  }
  return { prices, partial: ordered.length > capped.length || failed, failed };
}

export type TokenInfo = { symbol: string; name: string; verified: boolean };

const symbolCache = new Map<string, { info: TokenInfo | null; at: number }>();

/** Symbols and verification for up to 100 mints. `failed` is true when the lookup still failed after retries. */
export async function fetchSymbols(mints: string[], deadline: number): Promise<{ symbols: Record<string, TokenInfo>; failed: boolean }> {
  const symbols: Record<string, TokenInfo> = {};
  const now = Date.now();
  const missing = mints.slice(0, 100).filter((m) => {
    const hit = symbolCache.get(m);
    if (!hit || now - hit.at > CACHE_MS) return true;
    if (hit.info) symbols[m] = hit.info;
    return false;
  });
  if (missing.length === 0) return { symbols, failed: false };
  const list = await getJson<{ id: string; symbol?: string; name?: string; isVerified?: boolean }[]>(
    `${JUP}/tokens/v2/search?query=${missing.join(',')}`,
    deadline,
  );
  if (!list) return { symbols, failed: true };
  for (const token of list) {
    if (!token.symbol) continue;
    // Wrapped SOL reports itself as "SOL"; keep it distinct from native SOL in the list.
    const symbol = token.id === WSOL_MINT ? 'wSOL' : token.symbol;
    symbols[token.id] = { symbol, name: token.name ?? symbol, verified: token.isVerified === true };
  }
  for (const m of missing) symbolCache.set(m, { info: symbols[m] ?? null, at: Date.now() });
  return { symbols, failed: false };
}
