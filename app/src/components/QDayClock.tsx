import { t } from '../copy';
import { DEADLINES, ESTIMATES, RECORD, STATS, type Entry } from '../data/qday';
import { Card, cn, SourceLink } from './ui';

function Timeline({ entries }: { entries: Entry[] }) {
  return (
    <ol className="relative ml-1 border-l border-line-strong pl-5">
      {entries.map((e) => (
        <li key={e.url + e.date} className={cn('relative mb-5 last:mb-0', e.highlight && '-mx-3 rounded-xl bg-canary/[0.05] px-3 py-2.5 ring-1 ring-inset ring-canary/20')}>
          <span
            aria-hidden
            className={cn(
              'absolute h-2.5 w-2.5 rounded-full',
              // Centered on the 1px rule: normal items start 21px right of it, highlighted ones 9px (they bleed out by 12px).
              e.highlight ? '-left-[13.5px] top-4 bg-canary ring-4 ring-canary/15' : '-left-[25.5px] top-1.5 bg-fg-subtle',
            )}
          />
          <p className="font-mono text-[11px] tabular-nums text-fg-subtle">{e.date}</p>
          <p className={cn('text-sm leading-6', e.highlight ? 'text-fg' : 'text-fg-muted')}>
            {e.text} <SourceLink url={e.url} />
          </p>
        </li>
      ))}
    </ol>
  );
}

export function QDayClock() {
  const pct = (RECORD.bits / RECORD.targetBits) * 100;

  return (
    <div className="space-y-6">
      <Card>
        <p className="text-sm text-fg-muted">{t('recordLabel')}</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <p className="font-mono text-6xl font-medium tabular-nums text-canary">
            {RECORD.bits}
            <span className="ml-2 text-xl text-fg-subtle">
              / {RECORD.targetBits} {t('bits')}
            </span>
          </p>
          <p className="text-sm text-fg-muted">{t('recordTarget')}</p>
        </div>
        <div
          role="meter"
          aria-valuemin={0}
          aria-valuemax={RECORD.targetBits}
          aria-valuenow={RECORD.bits}
          aria-label={t('recordMeter', { bits: RECORD.bits, target: RECORD.targetBits })}
          className="relative mt-4 h-3 overflow-hidden rounded-full bg-[repeating-linear-gradient(90deg,var(--color-line-strong)_0_1px,transparent_1px_calc(100%/32))] ring-1 ring-inset ring-line"
        >
          <div className="h-full rounded-full bg-linear-to-r from-beak to-canary shadow-[0_0_16px_rgb(255_210_63/0.6)]" style={{ width: `${pct}%` }} />
        </div>
        <div aria-hidden className="mt-2 flex justify-between font-mono text-[11px] tabular-nums text-fg-subtle">
          <span>0</span>
          <span>64</span>
          <span>128</span>
          <span>192</span>
          <span>256</span>
        </div>
        <p className="mt-4 text-xs leading-5 text-fg-subtle">
          {RECORD.text} <SourceLink url={RECORD.url} />
        </p>
        <p className="mt-1 text-xs leading-5 text-fg-subtle">{t('recordNote')}</p>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        {STATS.map((s) => (
          <Card key={s.url} className="p-5! sm:p-5!">
            <p className="font-mono text-3xl font-medium tabular-nums text-fg">{s.value}</p>
            <p className="mt-2 text-sm leading-6 text-fg-muted">
              {s.text} <SourceLink url={s.url} />
            </p>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <h3 className="mb-4 text-base font-semibold tracking-tight">{t('timelineTitle')}</h3>
          <Timeline entries={ESTIMATES} />
        </Card>
        <Card>
          <h3 className="mb-4 text-base font-semibold tracking-tight">{t('deadlinesTitle')}</h3>
          <Timeline entries={DEADLINES} />
        </Card>
      </div>
    </div>
  );
}
