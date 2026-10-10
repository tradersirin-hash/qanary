export function usd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

export function amount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: value >= 1 ? 4 : 8 }).format(value);
}

/** Exact SOL from lamports (9 decimals, trailing zeros trimmed), with no rounding: 1 lamport is "0.000000001". */
export function exactSol(lamportsValue: bigint): string {
  const s = lamportsValue.toString().padStart(10, '0');
  const frac = s.slice(-9).replace(/0+$/, '');
  return frac ? `${s.slice(0, -9)}.${frac}` : s.slice(0, -9);
}

export function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}
