import { t } from '../copy';

/** An error whose message is already written for the user. */
export class UserFacingError extends Error {}

export const isRejection = (e: unknown) => /reject|denied|cancel/i.test(e instanceof Error ? e.message : String(e));

export function friendlyError(e: unknown): { text: string; details?: string } {
  if (e instanceof UserFacingError) return { text: e.message };
  const raw = e instanceof Error ? e.message : String(e);
  if (isRejection(e)) return { text: t('errCancelled') };
  if (/insufficient|no record of a prior credit/i.test(raw)) return { text: t('errFunds') };
  if (raw.startsWith('Transaction failed:')) return { text: t('errProgram'), details: raw };
  return { text: raw };
}
