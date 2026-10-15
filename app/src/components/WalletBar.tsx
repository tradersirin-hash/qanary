import { useEffect, useRef, useState } from 'react';
import { clusterTag, DEPLOYMENT, t } from '../copy';
import type { Cluster } from '../lib/cluster';
import { friendlyError } from '../lib/errors';
import { short } from '../lib/format';
import type { WalletState } from '../lib/useWallet';
import { Power } from './icons';
import { Button } from './ui';

/** Connect button plus a disclosure panel listing wallets (not a role="menu": no arrow-key navigation). Once connected,
 *  a tag names `cluster`, where this page's transactions go; null hides it. */
export function WalletBar({ w, cluster }: { w: WalletState; cluster: Cluster | null }) {
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  /** True only while a connect or disconnect started here is in flight, so page load and auto-reconnect never move focus. */
  const justActed = useRef(false);
  const connected = !!w.account;

  // The focused control unmounts when the connection changes: move focus to its counterpart instead of <body>.
  useEffect(() => {
    if (!justActed.current) return;
    justActed.current = false;
    (connected ? disconnectRef : triggerRef).current?.focus();
  }, [connected]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  if (w.account) {
    return (
      <div className="flex items-center gap-1 rounded-full border border-line bg-panel p-1">
        {cluster && (
          <span className="rounded-full bg-caution/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-orange-200 ring-1 ring-inset ring-caution/30">
            {clusterTag(cluster)}
          </span>
        )}
        <span className="flex items-center gap-2 rounded-full bg-white/[0.04] px-2.5 py-1 font-mono text-xs text-fg">
          {w.wallet && <img src={w.wallet.icon} alt="" width={16} height={16} className="hidden h-4 w-4 sm:block" />}
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-safe" />
          {short(w.account.address)}
        </span>
        <button
          ref={disconnectRef}
          type="button"
          aria-label={t('disconnect')}
          title={t('disconnect')}
          onClick={() => {
            justActed.current = true;
            void w.disconnectNow();
          }}
          className="grid h-8 w-8 place-items-center rounded-full text-fg-subtle hover:bg-white/5 hover:text-fg"
        >
          <Power className="h-4 w-4" />
        </button>
      </div>
    );
  }

  const connectTo = (wallet: WalletState['wallets'][number]) => {
    setError(null);
    setConnecting(wallet.name);
    justActed.current = true;
    w.connectTo(wallet)
      .then(() => setOpen(false))
      .catch((e: unknown) => {
        justActed.current = false;
        setError(friendlyError(e).text);
      })
      .finally(() => setConnecting(null));
  };

  return (
    <div className="relative">
      <Button ref={triggerRef} variant="primary" size="sm" aria-expanded={open} aria-controls="wallet-menu" onClick={() => setOpen((o) => !o)}>
        {t('connectWallet')}
      </Button>
      {open && (
        <div
          id="wallet-menu"
          ref={panelRef}
          className="absolute right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-panel/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl motion-safe:animate-rise"
        >
          <p className="px-3 pt-2 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">{DEPLOYMENT.walletsTitle}</p>
          <p className="px-3 pb-2 pt-1 text-xs leading-5 text-fg-subtle">{DEPLOYMENT.walletsHint}</p>
          {w.wallets.length === 0 && <p className="px-3 pb-2 text-sm leading-6 text-fg-muted">{t('noWallet')}</p>}
          {w.wallets.map((wallet) => (
            <button
              key={wallet.name}
              type="button"
              disabled={!!connecting}
              onClick={() => connectTo(wallet)}
              className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-fg hover:bg-white/[0.05] disabled:opacity-50"
            >
              <img src={wallet.icon} alt="" width={20} height={20} className="h-5 w-5" />
              {wallet.name}
              {connecting === wallet.name && <span className="ml-auto text-xs text-fg-subtle">{t('connecting')}</span>}
            </button>
          ))}
          {error && (
            <p role="alert" className="px-3 py-2 text-xs text-red-300 wrap-anywhere">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
