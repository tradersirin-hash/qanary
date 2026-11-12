import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import type { CanaryState } from './qanary';
import { honeypotDrained } from './useCanary';

const canary = (over: Partial<CanaryState>): CanaryState => ({
  address: 'DDNM18i4XcRS2n2Uwh8BaYQcJhJZBz4hRjK4pyZbbq1Q' as Address,
  tripped: false,
  trippedSlot: 0n,
  claimer: null,
  honeypotBaseline: 300_000_000n,
  honeypotLamports: 300_000_000n,
  totalFunded: 300_000_000n,
  pool: 300_000_000n,
  ...over,
});

describe('honeypotDrained', () => {
  it('flags a honeypot even one lamport below its baseline', () => {
    expect(honeypotDrained(canary({ honeypotLamports: 299_999_999n }))).toBe(true);
    expect(honeypotDrained(canary({ honeypotLamports: 0n }))).toBe(true);
  });

  it('leaves a balance at or above the baseline alone (a surplus is a plain deposit, not a drop)', () => {
    expect(honeypotDrained(canary({}))).toBe(false);
    expect(honeypotDrained(canary({ honeypotLamports: 400_000_000n }))).toBe(false);
  });

  it('leaves a tripped canary to its own state', () => {
    expect(honeypotDrained(canary({ tripped: true, trippedSlot: 509_516_900n, honeypotLamports: 0n }))).toBe(false);
  });
});
