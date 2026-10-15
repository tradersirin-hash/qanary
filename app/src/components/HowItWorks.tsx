import type { ReactNode } from 'react';
import { DEPLOYMENT, t, tOn, type Key } from '../copy';
import type { Cluster } from '../lib/cluster';
import { BOUNTY_PROGRAM_ID, CANARY_CLUSTER, RUST_TEST_COUNT, VAULT_CLUSTER, VAULT_PROGRAM_ID } from '../lib/constants';
import { explorer } from '../lib/links';
import { Link, PATHS } from '../lib/router';
import { Key as KeyIcon, Radar } from './icons';
import { AddressChip, Card, LiveTag, Section } from './ui';

type Step = {
  n: string;
  live: string;
  icon: ReactNode;
  title: Key;
  tag: Key;
  body: string;
  link: Key;
  href: string;
  /** The step's program and the cluster it runs on. */
  program?: { id: string; cluster: Cluster };
};

const STEPS: Step[] = [
  {
    n: '01',
    live: t('liveMainnet'),
    icon: <Radar className="h-5 w-5" />,
    title: 'howScanTitle',
    tag: 'howScanTag',
    body: t('howScanBody'),
    link: 'howScanLink',
    href: PATHS.home,
  },
  {
    n: '02',
    live: tOn(VAULT_CLUSTER, 'liveCluster'),
    icon: <KeyIcon className="h-5 w-5" />,
    title: 'howVaultTitle',
    tag: 'howVaultTag',
    body: tOn(VAULT_CLUSTER, 'howVaultBody'),
    link: 'howVaultLink',
    href: PATHS.vault,
    program: { id: VAULT_PROGRAM_ID, cluster: VAULT_CLUSTER },
  },
  {
    n: '03',
    live: tOn(CANARY_CLUSTER, 'liveCluster'),
    icon: <img src="/qanary.svg" alt="" width={24} height={24} className="h-6 w-6" />,
    title: 'howBountyTitle',
    tag: 'howBountyTag',
    body: DEPLOYMENT.howBountyBody,
    link: 'howBountyLink',
    href: PATHS.bounty,
    program: { id: BOUNTY_PROGRAM_ID, cluster: CANARY_CLUSTER },
  },
];

export function HowItWorks() {
  return (
    <Section id="how" eyebrow={t('howEyebrow')} title={t('howTitle')} sub={t('howSub')}>
      <ol className="grid gap-4 md:grid-cols-3">
        {STEPS.map((s) => (
          <li key={s.n} className="flex">
            <Card className="flex w-full flex-col">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-fg-subtle">{s.n}</span>
                <LiveTag label={s.live} />
              </div>
              <div className="mt-4 grid h-11 w-11 place-items-center rounded-xl bg-canary/10 text-canary ring-1 ring-inset ring-canary/25">{s.icon}</div>
              <h2 className="mt-4 text-base font-semibold tracking-tight">{t(s.title)}</h2>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-canary/80">{t(s.tag)}</p>
              <p className="mt-2 text-sm leading-6 text-fg-muted">{s.body}</p>
              {s.program && (
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                  {t('programLabel')} <AddressChip value={s.program.id} href={explorer(s.program.cluster, `address/${s.program.id}`)} />
                </div>
              )}
              <Link to={s.href} className="mt-auto inline-flex items-center gap-1 pt-4 text-sm font-medium text-canary transition-all hover:gap-1.5">
                {t(s.link)} <span aria-hidden>→</span>
              </Link>
            </Card>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-xs leading-5 text-fg-subtle">
        {t('howNote')}
        {RUST_TEST_COUNT > 0 && <> · {t('testsNote', { n: RUST_TEST_COUNT })}</>}
      </p>
    </Section>
  );
}
