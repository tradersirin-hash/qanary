import { address, type Address, type Instruction } from '@solana/kit';
import { useState } from 'react';
import { t, type Key } from '../copy';
import { CANARY_KEY_ID } from '../lib/constants';
import { friendlyError } from '../lib/errors';
import { amount } from '../lib/format';
import { explorerDevnet, REPO_URL } from '../lib/links';
import {
  canaryAddress,
  checkHoneypotIx,
  fundHoneypotIx,
  fundIx,
  initializeCanaryIx,
  MaybeLanded,
  parseSol,
  send,
  type CanaryState,
} from '../lib/qanary';
import { knownCanary, type CanaryView } from '../lib/useCanary';
import type { WalletState } from '../lib/useWallet';
import { AlertTriangle, ArrowUpRight } from './icons';
import {
  AddressChip,
  Button,
  Callout,
  Card,
  cn,
  FIELD_LABEL,
  Skeleton,
  SolInput,
  Stat,
  StatGrid,
  TxFeedback,
  type Progress,
  type Status,
} from './ui';

const sol = (lamports: bigint) => `${amount(Number(lamports) / 1e9)} SOL`;
const HINT = 'mt-1.5 text-[11px] leading-4 text-fg-subtle';

type Props = { w: WalletState; view: CanaryView; refresh: () => Promise<CanaryState | null> };

function headline(view: CanaryView): { text: Key; className: string } | null {
  switch (view.kind) {
    case 'loading':
      return null;
    case 'live':
      return view.state.tripped ? { text: 'canaryTripped', className: 'text-red-300' } : { text: 'canaryAlive', className: 'text-emerald-300' };
    case 'notInitialized':
      return { text: 'canaryNotInitialized', className: 'text-fg' };
    case 'notDeployed':
      return { text: 'canaryNotDeployed', className: 'text-fg' };
    case 'error':
      return { text: 'canaryRpcError', className: 'text-fg' };
  }
}

export function CanaryPanel({ w, view, refresh }: Props) {
  const [fund, setFund] = useState('0.1');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  const state = knownCanary(view);
  const live = view.kind === 'live' ? view.state : null;
  const tripped = state?.tripped ?? false;
  const alive = !!live && !live.tripped;
  const head = headline(view);
  const checkedAt = view.kind === 'loading' ? null : view.checkedAt;

  /** Sends one wallet transaction with the shared step list, then re-reads the canary for the success message. */
  const run = async (id: string, build: (payer: Address) => Promise<Instruction[]>, done: (c: CanaryState | null) => string) => {
    if (!w.wallet || !w.account) return setStatus({ tone: 'error', text: t('connectFirst') });
    const labels = [t('stepApproveTx', { wallet: w.wallet.name }), t('stepConfirm')];
    setBusy(id);
    setStatus(null);
    setProgress({ labels, active: 0 });
    try {
      const ixs = await build(address(w.account.address));
      const tx = await send(w.wallet, w.account, ixs, (s) => setProgress({ labels, active: s === 'approve' ? 0 : 1 }));
      const c = await refresh();
      setStatus({ tone: 'success', text: done(c), tx });
    } catch (e) {
      if (e instanceof MaybeLanded) setStatus({ tone: 'error', text: e.message, tx: e.signature });
      else setStatus({ tone: 'error', ...friendlyError(e) });
    } finally {
      setProgress(null);
      setBusy(null);
    }
  };

  /** Validates the amount before the wallet is asked anything. */
  const withAmount = (go: (value: bigint) => void) => {
    const value = parseSol(fund);
    if (!value) return setStatus({ tone: 'error', text: t('badAmount') });
    go(value);
  };

  const fundBounty = () =>
    withAmount((value) =>
      void run('bounty', async (payer) => [fundIx(payer, live!.address, value)], () => t('fundBountyOk', { amount: amount(Number(value) / 1e9) })),
    );
  const fundHoneypot = () =>
    withAmount((value) =>
      void run('honeypot', async (payer) => [fundHoneypotIx(payer, live!.address, value)], () => t('fundHoneypotOk', { amount: amount(Number(value) / 1e9) })),
    );
  const watchdog = () => run('watchdog', async () => [checkHoneypotIx(live!.address)], (c) => t(c?.tripped ? 'watchdogTripped' : 'watchdogOk'));
  const initialize = () => run('init', async (payer) => [initializeCanaryIx(payer, await canaryAddress())], () => t('canaryInitOk'));

  return (
    <Card accent className={tripped ? 'border-danger/40! bg-danger/[0.05]!' : undefined}>
      <div className="flex flex-wrap items-center gap-4">
        <div
          className={cn(
            'relative grid h-14 w-14 shrink-0 place-items-center rounded-2xl ring-1 ring-inset',
            alive ? 'bg-safe/10 ring-safe/30' : tripped ? 'bg-danger/10 ring-danger/30' : 'bg-white/5 ring-white/10',
          )}
        >
          {tripped ? (
            <AlertTriangle className="h-6 w-6 text-danger" />
          ) : (
            <img src="/qanary.svg" alt="" width={28} height={28} className={cn('h-7 w-7', !alive && 'opacity-60 grayscale')} />
          )}
          {alive && (
            <span aria-hidden className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-400" />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {/* Only the state itself is a live region; the "last checked" time changes every 30 s and is not announced. */}
          <div role="status">
            {head ? (
              <p className={cn('text-lg font-semibold leading-7 text-pretty', head.className)}>{t(head.text)}</p>
            ) : (
              <>
                <Skeleton className="h-5 w-48" />
                <span className="sr-only">{t('canaryLoading')}</span>
              </>
            )}
          </div>
          {checkedAt && (
            <p className="mt-0.5 font-mono text-xs text-fg-subtle">{t('lastChecked', { time: new Date(checkedAt).toLocaleTimeString('en-US') })}</p>
          )}
        </div>
        {view.kind === 'error' && (
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            {t('retryNow')}
          </Button>
        )}
      </div>

      {state && (
        <StatGrid className="mt-5 sm:grid-cols-3">
          <Stat label={t('bountyPool')} value={sol(state.pool)} valueClass="font-mono text-2xl font-medium text-canary" />
          <Stat label={t('honeypot')} value={sol(state.honeypotLamports)} />
          <Stat label={t('canaryKey')} value={<AddressChip value={CANARY_KEY_ID} href={explorerDevnet(`address/${CANARY_KEY_ID}`)} />} valueClass="text-sm" />
        </StatGrid>
      )}

      <Callout tone="info" title={t('signalTitle')} className="mt-5">
        {t('signalBody')}
      </Callout>

      <details className="mt-4 rounded-xl border border-line bg-ink/40 p-4">
        <summary className="cursor-pointer text-sm font-medium text-fg">{t('verifySummary')}</summary>
        <p className="mt-3 text-sm leading-6 text-fg-muted">{t('verifyBody')}</p>
        <pre tabIndex={0} className="mt-2 overflow-x-auto rounded-lg bg-ink px-3 py-2 font-mono text-xs text-fg">
          {t('verifyFormula')}
        </pre>
        <p className="mt-2 text-xs leading-5 text-fg-subtle wrap-anywhere">{t('verifyHow')}</p>
        {REPO_URL && (
          <a
            href={`${REPO_URL}/blob/main/onchain/scripts/canary_key.py`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-canary hover:underline"
          >
            {t('viewScript')}
            <ArrowUpRight className="h-3 w-3" />
          </a>
        )}
      </details>

      {view.kind === 'notInitialized' && (
        <Button variant="primary" size="sm" className="mt-5" loading={busy === 'init'} disabled={!!busy} onClick={() => void initialize()}>
          {t('initCanary')}
        </Button>
      )}

      {alive && (
        <div className="mt-5 border-t border-line pt-5">
          <label htmlFor="canary-amount" className={FIELD_LABEL}>
            {t('amountSol')}
          </label>
          <div className="mt-2">
            <SolInput id="canary-amount" value={fund} onChange={setFund} disabled={!!busy} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <Button variant="primary" className="w-full" loading={busy === 'bounty'} disabled={!!busy} onClick={fundBounty}>
                {t('fundBounty')}
              </Button>
              <p className={HINT}>{t('hintBounty')}</p>
            </div>
            <div>
              <Button className="w-full" loading={busy === 'honeypot'} disabled={!!busy} onClick={fundHoneypot}>
                {t('fundHoneypot')}
              </Button>
              <p className={HINT}>{t('hintHoneypot')}</p>
            </div>
            <div>
              <Button variant="ghost" className="w-full" loading={busy === 'watchdog'} disabled={!!busy} onClick={() => void watchdog()}>
                {t('runWatchdog')}
              </Button>
              <p className={HINT}>{t('hintWatchdog')}</p>
            </div>
          </div>
        </div>
      )}

      <TxFeedback progress={progress} status={status} />
    </Card>
  );
}
