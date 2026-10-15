import { t } from '../copy';
import type { Cluster } from './cluster';

/** An error whose message is already written for the user. */
export class UserFacingError extends Error {}

export const isRejection = (e: unknown) => /reject|denied|cancel/i.test(e instanceof Error ? e.message : String(e));

/** `cluster` is where the failed transaction was sent; only devnet has a faucet to point to. */
export function friendlyError(e: unknown, cluster?: Cluster): { text: string; details?: string } {
  if (e instanceof UserFacingError) return { text: e.message };
  const raw = e instanceof Error ? e.message : String(e);
  if (isRejection(e)) return { text: t('errCancelled') };
  if (/insufficient|no record of a prior credit/i.test(raw)) return { text: t(cluster === 'devnet' ? 'errFunds' : 'errFundsSol') };
  if (raw.startsWith('Transaction failed:')) return { text: t('errProgram'), details: raw };
  return { text: raw };
}
