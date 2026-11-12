import type { ReactNode } from 'react';
import { clusterTag, t, tOn, type Key } from '../copy';
import { RECORD, STATS } from '../data/qday';
import { CANARY_CLUSTER } from '../lib/constants';
import { amount } from '../lib/format';
import type { CanaryState } from '../lib/qanary';
import { honeypotDrained, type CanaryView } from '../lib/useCanary';
import { cn, Skeleton, SourceLink } from './ui';

function LiveFoot() {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-300">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-safe motion-safe:animate-pulse" />
      {tOn(CANARY_CLUSTER, 'liveCluster')}
    </span>
  );
}

function ClusterFoot() {
  return <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle">{clusterTag(CANARY_CLUSTER)}</span>;
}

function Cell({ label, value, foot }: { label: string; value: ReactNode; foot: ReactNode }) {
  return (
    <div className="min-w-0 bg-ink-2 px-5 py-6 sm:px-6">
      <dt className="text-xs leading-5 text-fg-subtle">{label}</dt>
      <dd className="mt-2 font-mono text-2xl font-medium tabular-nums text-fg">{value}</dd>
      <dd className="mt-2">{foot}</dd>
    </div>
  );
}

const CANARY_WORD: Record<'notInitialized' | 'notDeployed' | 'error', Key> = {
  notInitialized: 'statNotInit',
  notDeployed: 'statNotDeployed',
  error: 'statUnreachable',
};

/** The word for a canary read live: a honeypot below its baseline is as red as a tripped flag. */
function LiveWord({ state }: { state: CanaryState }) {
  const drained = honeypotDrained(state);
  const word: Key = state.tripped ? 'statTripped' : drained ? 'statDrained' : 'statAlive';
  return <span className={state.tripped || drained ? 'text-red-300' : 'text-emerald-300'}>{t(word)}</span>;
}

/** Live canary state and pool (on the canary's cluster), plus two sourced Q-Day numbers. No invented figures. */
export function StatsStrip({ view }: { view: CanaryView }) {
  const live = view.kind === 'live' ? view.state : null;
  const foot = live ? <LiveFoot /> : <ClusterFoot />;

  const canaryValue =
    view.kind === 'loading' ? (
      <Skeleton className="h-8 w-24" />
    ) : view.kind === 'live' ? (
      <LiveWord state={view.state} />
    ) : (
      <span className={cn('text-xl', view.kind === 'error' && 'text-fg-muted')}>{t(CANARY_WORD[view.kind])}</span>
    );

  const poolValue = view.kind === 'loading' ? <Skeleton className="h-8 w-28" /> : live ? `${amount(Number(live.pool) / 1e9)} SOL` : '–';

  return (
    <section aria-label={t('statusStripLabel')} className="border-y border-line bg-ink-2/80">
      <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-line md:grid-cols-4">
        <Cell label={t('statCanary')} value={canaryValue} foot={foot} />
        <Cell label={t('statPool')} value={poolValue} foot={foot} />
        <Cell
          label={t('statRecord')}
          value={
            <>
              {RECORD.bits} <span className="text-base text-fg-subtle">/ {RECORD.targetBits} {t('bits')}</span>
            </>
          }
          foot={<SourceLink url={RECORD.url} />}
        />
        <Cell label={t('statOdds')} value={STATS[0].value} foot={<SourceLink url={STATS[0].url} />} />
      </dl>
    </section>
  );
}
