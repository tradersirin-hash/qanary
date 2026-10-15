import { useCallback, useEffect, useState } from 'react';
import type { Cluster } from './cluster';
import { CANARY_CLUSTER } from './constants';
import type { CanaryState } from './qanary';

export type CanaryView =
  | { kind: 'loading' }
  | { kind: 'live'; state: CanaryState; checkedAt: number }
  | { kind: 'notInitialized' | 'notDeployed'; checkedAt: number }
  | { kind: 'error'; checkedAt: number; last?: CanaryState };

export const knownCanary = (v: CanaryView) => (v.kind === 'live' ? v.state : v.kind === 'error' ? v.last : undefined);

/** Canary state on `cluster` for the stats strip, the vault and the bounty panel; App holds one per cluster it shows.
 *  Polls only while `active` (a page that shows canary data is open) and refreshes as soon as it becomes active. */
export function useCanary(active = true, cluster: Cluster = CANARY_CLUSTER) {
  const [view, setView] = useState<CanaryView>({ kind: 'loading' });
  const refresh = useCallback(async (): Promise<CanaryState | null> => {
    try {
      const q = await import('./qanary'); // keeps kit out of the main bundle
      const c = await q.fetchCanary(cluster);
      if (c) {
        setView({ kind: 'live', state: c, checkedAt: Date.now() });
        return c;
      }
      setView({ kind: (await q.bountyDeployed(cluster)) ? 'notInitialized' : 'notDeployed', checkedAt: Date.now() });
      return null;
    } catch {
      // An RPC failure is NOT "not live": say so honestly and keep the last known state.
      setView((v) => ({ kind: 'error', checkedAt: Date.now(), last: knownCanary(v) }));
      return null;
    }
  }, [cluster]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh, active]);
  return { view, refresh };
}
