import { isAddress as isSolanaAddress } from '@solana/kit';
import { getAddress, isAddress as isEvmAddress, type Address as EvmAddress } from 'viem';

export type Detected = { chain: 'solana'; value: string } | { chain: 'evm'; value: EvmAddress } | null;

export function detectAddress(raw: string): Detected {
  const value = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    const hex = value.slice(2);
    // Mixed case carries an EIP-55 checksum; a wrong one means a typo, so reject it rather than scan the wrong address.
    const mixedCase = /[a-f]/.test(hex) && /[A-F]/.test(hex);
    if (mixedCase && !isEvmAddress(value, { strict: true })) return null;
    return { chain: 'evm', value: getAddress(value.toLowerCase()) };
  }
  if (isSolanaAddress(value)) return { chain: 'solana', value };
  return null;
}
