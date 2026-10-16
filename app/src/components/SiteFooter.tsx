import { DEPLOYMENT, t, tOn, type Key } from '../copy';
import { RECORD } from '../data/qday';
import type { Cluster } from '../lib/cluster';
import { BOUNTY_PROGRAM_ID, CANARY_CLUSTER, CANARY_KEY_ID, TOKEN_MINT, VAULT_CLUSTER, VAULT_PROGRAM_ID } from '../lib/constants';
import { explorer, REPO_URL, solscanToken, STANDARDS, TELEGRAM_URL, X_URL } from '../lib/links';
import { ArrowUpRight } from './icons';
import { AddressChip } from './ui';

const PROGRAMS: { label: Key; id: string; cluster: Cluster }[] = [
  { label: 'vaultProgram', id: VAULT_PROGRAM_ID, cluster: VAULT_CLUSTER },
  { label: 'bountyProgram', id: BOUNTY_PROGRAM_ID, cluster: CANARY_CLUSTER },
  { label: 'canaryKey', id: CANARY_KEY_ID, cluster: CANARY_CLUSTER },
];
const SPLIT = CANARY_CLUSTER !== VAULT_CLUSTER;

const COLUMN_TITLE = 'font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle';
const LINK = 'inline-flex items-center gap-1 text-fg-muted hover:text-canary';

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-ink-2">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <img src="/qanary.svg" alt="" width={28} height={28} className="h-7 w-7" />
              <span className="text-[17px] font-semibold tracking-[-0.02em]">Qanary</span>
            </div>
            <p className="mt-2 text-sm text-fg-muted">{t('tagline')}</p>
            <h2 className="mt-8 text-sm font-semibold text-fg">{t('limitsTitle')}</h2>
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-xs leading-5 text-fg-subtle marker:text-line-strong">
              <li>{t('limit1')}</li>
              <li>{t('limit2', { bits: RECORD.bits })}</li>
              <li>{t('limit3')}</li>
              <li>{DEPLOYMENT.limit4}</li>
              <li>{t('oneDevice')}</li>
              <li>{t('limit6')}</li>
            </ul>
          </div>

          <div className="min-w-0">
            <h2 className={COLUMN_TITLE}>{DEPLOYMENT.programsTitle}</h2>
            <dl className="mt-4 space-y-4">
              {PROGRAMS.map((p) => (
                <div key={p.id}>
                  {/* On one cluster the column title names it; split across clusters, each entry does. */}
                  <dt className="text-xs text-fg-muted">{SPLIT ? tOn(p.cluster, 'programOn', { program: t(p.label) }) : t(p.label)}</dt>
                  <dd className="mt-1">
                    <AddressChip full value={p.id} href={explorer(p.cluster, `address/${p.id}`)} />
                  </dd>
                </div>
              ))}
            </dl>
            <h2 className={`mt-8 ${COLUMN_TITLE}`}>{t('tokenFooterTitle')}</h2>
            <dl className="mt-4">
              <dt className="text-xs text-fg-muted">{t('tokenLabel')}</dt>
              <dd className="mt-1">
                <AddressChip full value={TOKEN_MINT} href={solscanToken(TOKEN_MINT)} />
              </dd>
            </dl>
          </div>

          <div className="min-w-0">
            <h2 className={COLUMN_TITLE}>{t('standardsTitle')}</h2>
            <ul className="mt-4 space-y-2 text-sm">
              {STANDARDS.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer" className={LINK}>
                    {t(s.label)}
                    <ArrowUpRight className="h-3 w-3 shrink-0" />
                  </a>
                </li>
              ))}
              {REPO_URL && (
                <li>
                  <a href={REPO_URL} target="_blank" rel="noreferrer" className={LINK}>
                    {t('sourceCode')}
                    <ArrowUpRight className="h-3 w-3 shrink-0" />
                  </a>
                </li>
              )}
              <li>
                <a href={X_URL} target="_blank" rel="noreferrer" className={LINK}>
                  {t('xProfile')}
                  <ArrowUpRight className="h-3 w-3 shrink-0" />
                </a>
              </li>
              <li>
                <a href={TELEGRAM_URL} target="_blank" rel="noreferrer" className={LINK}>
                  {t('telegram')}
                  <ArrowUpRight className="h-3 w-3 shrink-0" />
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-wrap justify-between gap-3 border-t border-line/60 pt-5 text-xs text-fg-subtle">
          <p>{DEPLOYMENT.footerBar}</p>
          <p>{t('builtFor')}</p>
        </div>
      </div>
    </footer>
  );
}
