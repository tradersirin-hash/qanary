import type { ReactNode } from 'react';
import { t, type Key } from '../copy';
import { Bell, Code, FileText, Radar, ShieldCheck } from './icons';
import { Callout, Card, cn, Section } from './ui';

type Phase = 'live' | 'planned' | 'afterAudit';

const PHASE: Record<Phase, { label: Key; className: string }> = {
  live: { label: 'phaseLive', className: 'bg-safe/10 text-emerald-300 ring-safe/25' },
  planned: { label: 'phasePlanned', className: 'bg-info/10 text-sky-300 ring-info/25' },
  afterAudit: { label: 'phaseAfterAudit', className: 'bg-caution/10 text-orange-200 ring-caution/30' },
};

type Tier = { phase: Phase; icon: ReactNode; title: Key; audience: Key; body: Key; pricing: Key };

// Listed roughly in the order we intend to offer them.
const TIERS: Tier[] = [
  {
    phase: 'live',
    icon: <Radar className="h-5 w-5" />,
    title: 'tierScanTitle',
    audience: 'tierScanFor',
    body: 'tierScanBody',
    pricing: 'tierScanPrice',
  },
  {
    phase: 'planned',
    icon: <Code className="h-5 w-5" />,
    title: 'tierApiTitle',
    audience: 'tierApiFor',
    body: 'tierApiBody',
    pricing: 'tierApiPrice',
  },
  {
    phase: 'planned',
    icon: <Bell className="h-5 w-5" />,
    title: 'tierWatchTitle',
    audience: 'tierWatchFor',
    body: 'tierWatchBody',
    pricing: 'tierWatchPrice',
  },
  {
    phase: 'planned',
    icon: <FileText className="h-5 w-5" />,
    title: 'tierReportTitle',
    audience: 'tierReportFor',
    body: 'tierReportBody',
    pricing: 'tierReportPrice',
  },
  {
    phase: 'planned',
    icon: <img src="/qanary.svg" alt="" width={24} height={24} className="h-6 w-6 opacity-70 grayscale" />,
    title: 'tierCanaryTitle',
    audience: 'tierCanaryFor',
    body: 'tierCanaryBody',
    pricing: 'tierCanaryPrice',
  },
  {
    phase: 'afterAudit',
    icon: <ShieldCheck className="h-5 w-5" />,
    title: 'tierVaultProTitle',
    audience: 'tierVaultProFor',
    body: 'tierVaultProBody',
    pricing: 'tierVaultProPrice',
  },
];

function PhaseTag({ phase }: { phase: Phase }) {
  const p = PHASE[phase];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] ring-1 ring-inset',
        p.className,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {t(p.label)}
    </span>
  );
}

export function BusinessModel() {
  return (
    <Section id="roadmap" index="05" eyebrow={t('modelEyebrow')} title={t('modelTitle')} sub={t('modelSub')}>
      <ol className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {TIERS.map((tier, i) => {
          const live = tier.phase === 'live';
          return (
            <li key={tier.title} className="flex">
              <Card accent={live} className="flex w-full flex-col">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-fg-subtle">{String(i + 1).padStart(2, '0')}</span>
                  <PhaseTag phase={tier.phase} />
                </div>
                {/* Only live products get the canary-yellow tile; planned ones stay muted. */}
                <div
                  className={cn(
                    'mt-4 grid h-11 w-11 place-items-center rounded-xl ring-1 ring-inset',
                    live ? 'bg-canary/10 text-canary ring-canary/25' : 'bg-white/5 text-fg-muted ring-white/10',
                  )}
                >
                  {tier.icon}
                </div>
                <h2 className="mt-4 text-base font-semibold tracking-tight">{t(tier.title)}</h2>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-canary/80">{t(tier.audience)}</p>
                <p className="mt-2 text-sm leading-6 text-fg-muted">{t(tier.body)}</p>
                <p className="mt-auto pt-4 text-xs text-fg-subtle">
                  <span className="font-medium text-fg-muted">{t('pricingLabel')}</span> {t(tier.pricing)}
                </p>
              </Card>
            </li>
          );
        })}
      </ol>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <Callout tone="info" title={t('modelPublicTitle')}>
          {t('modelPublicBody')}
        </Callout>
        <Callout tone="caution" title={t('modelHonestTitle')}>
          {t('modelHonestBody')}
        </Callout>
      </div>
    </Section>
  );
}
