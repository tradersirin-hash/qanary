import { t } from '../copy';
import { TOKEN_MINT } from '../lib/constants';
import { pumpFun, solscanToken } from '../lib/links';
import { ArrowUpRight, Radar } from './icons';
import { AddressChip } from './ui';

const LINK = 'inline-flex items-center gap-1 text-sm text-fg-muted hover:text-canary';

/** The one official token address, so look-alike tokens are easy to tell apart. No price or market data on purpose. */
export function TokenStrip() {
  return (
    <section aria-label={t('tokenEyebrow')} className="border-b border-line bg-ink-2/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:gap-8 lg:px-8">
        <div className="min-w-0">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">
            {t('tokenEyebrow')} · <span className="text-canary">{t('tokenName')}</span>
          </p>
          <div className="mt-2">
            <AddressChip full value={TOKEN_MINT} href={solscanToken(TOKEN_MINT)} />
          </div>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-fg-subtle">
            {t('tokenOnly')} {t('tokenDisclaimer')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-5">
          <a href={`/?a=${TOKEN_MINT}`} className={LINK}>
            <Radar className="h-3.5 w-3.5" />
            {t('tokenScanIt')}
          </a>
          <a href={pumpFun(TOKEN_MINT)} target="_blank" rel="noreferrer" className={LINK}>
            {t('tokenPumpFun')}
            <ArrowUpRight className="h-3 w-3 shrink-0" />
          </a>
        </div>
      </div>
    </section>
  );
}
