// Jupiter's public APIs: wallet holdings, USD prices and token symbols. Every call fails soft.
const JUP = 'https://lite-api.jup.ag';
const PRICE_BATCH = 50;
/** The keyless API allows about 30 requests a minute, so very large wallets are priced partially. */
const MAX_PRICED_MINTS = 300;
const TIMEOUT_MS = 15_000;

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Priced first so a capped price lookup still covers the usual large holdings. */
const MAJOR_MINTS = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
];

export type Holdings = { lamports: bigint; tokens: { mint: string; amount: bigint; uiAmount: number }[] };

type HoldingsResponse = {
  amount: string;
  tokens: Record<string, { amount: string; uiAmount: number; excludeFromNetWorth?: boolean }[]>;
};

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** SOL and token balances of a wallet, merged per mint. Returns null if Jupiter is unreachable. */
export async function fetchHoldings(owner: string): Promise<Holdings | null> {
  const json = await getJson<HoldingsResponse>(`${JUP}/ultra/v1/holdings/${owner}`);
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

export type Prices = { prices: Record<string, number>; partial: boolean };

/** USD prices. `partial` is true when some mints were skipped (cap) or a batch failed. */
export async function fetchUsdPrices(mints: string[]): Promise<Prices> {
  const unique = [...new Set(mints)];
  const ordered = [...MAJOR_MINTS.filter((m) => unique.includes(m)), ...unique.filter((m) => !MAJOR_MINTS.includes(m))];
  const capped = ordered.slice(0, MAX_PRICED_MINTS);
  const batches: string[][] = [];
  for (let i = 0; i < capped.length; i += PRICE_BATCH) batches.push(capped.slice(i, i + PRICE_BATCH));

  const results = await Promise.all(
    batches.map((batch) => getJson<Record<string, { usdPrice?: number } | null>>(`${JUP}/price/v3?ids=${batch.join(',')}`)),
  );
  const prices: Record<string, number> = {};
  for (const json of results) {
    for (const [mint, entry] of Object.entries(json ?? {})) {
      if (entry && typeof entry.usdPrice === 'number') prices[mint] = entry.usdPrice;
    }
  }
  return { prices, partial: ordered.length > capped.length || results.some((r) => r === null) };
}

export async function fetchSolPrice(): Promise<number | undefined> {
  const { prices } = await fetchUsdPrices([WSOL_MINT]);
  return prices[WSOL_MINT];
}

export type TokenInfo = { symbol: string; name: string; verified: boolean };

export async function fetchSymbols(mints: string[]): Promise<Record<string, TokenInfo>> {
  if (mints.length === 0) return {};
  const list = await getJson<{ id: string; symbol?: string; name?: string; isVerified?: boolean }[]>(
    `${JUP}/tokens/v2/search?query=${mints.slice(0, 100).join(',')}`,
  );
  const out: Record<string, TokenInfo> = {};
  for (const token of list ?? []) {
    if (!token.symbol) continue;
    // Wrapped SOL reports itself as "SOL"; keep it distinct from native SOL in the list.
    const symbol = token.id === WSOL_MINT ? 'wSOL' : token.symbol;
    out[token.id] = { symbol, name: token.name ?? symbol, verified: token.isVerified === true };
  }
  return out;
}
