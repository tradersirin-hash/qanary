import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { EvmResult } from './components/EvmResult';
import { HeroRadar } from './components/HeroRadar';
import { HowItWorks } from './components/HowItWorks';
import { AlertTriangle, Copy, Lock, Radar } from './components/icons';
import { QDayClock } from './components/QDayClock';
import { SiteFooter } from './components/SiteFooter';
import { SolanaResult } from './components/SolanaResult';
import { StatsStrip } from './components/StatsStrip';
import { Button, Card, cn, LiveTag, Section, Skeleton } from './components/ui';
import { WalletBar } from './components/WalletBar';
import { t, type Key } from './copy';
import { detectAddress } from './lib/detect';
import type { EvmReport } from './lib/evm';
import type { SolanaReport } from './lib/solana';
import { knownCanary, useCanary } from './lib/useCanary';
import { useWallet } from './lib/useWallet';

// The devnet panels pull in @solana/kit, bip39 and LM-OTS; they load as their own chunks.
const VaultPanel = lazy(() => import('./components/VaultPanel').then((m) => ({ default: m.VaultPanel })));
const CanaryPanel = lazy(() => import('./components/CanaryPanel').then((m) => ({ default: m.CanaryPanel })));
const PanelFallback = () => <div className="h-72 rounded-card border border-line bg-panel motion-safe:animate-pulse" />;

type Result = { chain: 'solana'; report: SolanaReport } | { chain: 'evm'; report: EvmReport };

const EXAMPLES: { label: Key; value: string; chain: 'SOL' | 'EVM' }[] = [
  { label: 'exUsdcMint', value: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: 'SOL' },
  { label: 'exVitalik', value: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', chain: 'EVM' },
  { label: 'exJupiter', value: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', chain: 'SOL' },
];

const NAV: { href: string; label: Key }[] = [
  { href: '#scan', label: 'navScan' },
  { href: '#how', label: 'navHow' },
  { href: '#vault', label: 'navVault' },
  { href: '#bounty', label: 'navBounty' },
  { href: '#qday', label: 'navQday' },
];

function readQuery(): string {
  return new URLSearchParams(window.location.search).get('a') ?? '';
}

function writeQuery(value: string) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set('a', value);
  else url.searchParams.delete('a');
  window.history.replaceState(null, '', url);
}

function ResultSkeleton() {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2 h-4 w-40" />
        </div>
      </div>
      <Skeleton className="mt-6 h-9 w-48" />
      <Skeleton className="mt-3 h-4 w-full" />
      <Skeleton className="mt-3 h-4 w-full" />
      <Skeleton className="mt-3 h-4 w-full" />
      <p className="mt-4 text-xs text-fg-subtle">{t('scanningCaption')}</p>
    </Card>
  );
}

export default function App() {
  const [input, setInput] = useState(readQuery);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<Key | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyState, setCopyState] = useState<Key | null>(null);
  // Only the latest scan may update the page; a slower earlier scan must not overwrite it.
  const latestScan = useRef(0);
  const wallet = useWallet();
  const canary = useCanary();
  const tripped = knownCanary(canary.view)?.tripped ?? false;
  const [activeSection, setActiveSection] = useState<string | null>(null);

  // Highlights the nav link of the section crossing the middle of the viewport.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActiveSection(e.target.id);
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    for (const n of NAV) {
      const el = document.getElementById(n.href.slice(1));
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  const scan = useCallback(async (raw: string) => {
    const id = ++latestScan.current;
    const detected = detectAddress(raw);
    setResult(null);
    if (!detected) {
      setError('invalid');
      setLoading(false);
      return;
    }
    setError(null);
    setInput(detected.value);
    writeQuery(detected.value);
    setLoading(true);
    try {
      // Chain SDKs load on first scan, so the landing page stays light.
      const next: Result =
        detected.chain === 'solana'
          ? { chain: 'solana', report: await (await import('./lib/solana')).scanSolana(detected.value) }
          : { chain: 'evm', report: await (await import('./lib/evm')).scanEvm(detected.value) };
      if (id === latestScan.current) setResult(next);
    } catch {
      if (id === latestScan.current) setError('networkError');
    } finally {
      if (id === latestScan.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = readQuery();
    if (initial) void scan(initial);
  }, [scan]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void scan(input);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyState('copied');
    } catch {
      // No Clipboard API (insecure origin, in-app webview) or permission denied.
      setCopyState('copyFailed');
    }
    setTimeout(() => setCopyState(null), 2000);
  };

  return (
    <>
      <a
        href="#scan-address"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-canary focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink"
      >
        {t('skipToScanner')}
      </a>

      <header className="sticky top-0 z-40 border-b border-line/60 bg-ink/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6 lg:px-8">
          <a href="/" aria-label={t('homeLabel')} className="group flex shrink-0 items-center gap-2.5">
            <img
              src="/qanary.svg"
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 transition group-hover:drop-shadow-[0_0_12px_rgb(255_210_63/0.35)]"
            />
            <span className="text-[17px] font-semibold tracking-[-0.02em]">Qanary</span>
          </a>
          <nav aria-label={t('navLabel')} className="hidden gap-1 md:flex">
            {NAV.map((n) => {
              const active = activeSection === n.href.slice(1);
              return (
                <a
                  key={n.href}
                  href={n.href}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-sm hover:bg-white/[0.04] hover:text-fg',
                    active ? 'bg-white/[0.05] text-fg' : 'text-fg-muted',
                  )}
                >
                  {t(n.label)}
                </a>
              );
            })}
          </nav>
          <div className="ml-auto">
            <WalletBar w={wallet} />
          </div>
        </div>
      </header>

      <main>
        <section id="scan" aria-labelledby="hero-title" className="relative isolate">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgb(255_210_63/0.12),transparent)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,rgb(255_255_255/0.035)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.035)_1px,transparent_1px)] bg-size-[48px_48px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]"
          />
          <div className="mx-auto grid max-w-6xl items-start gap-12 px-4 pb-16 pt-14 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:px-8 lg:pt-24">
            <div className="min-w-0">
              <p className="inline-flex items-center gap-2 rounded-full border border-line bg-panel/60 px-3 py-1 text-xs text-fg-muted">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-safe motion-safe:animate-pulse" />
                {t('heroLive')}
              </p>
              <h1 id="hero-title" className="mt-6 text-[2.25rem] font-semibold leading-[1.05] tracking-[-0.035em] text-balance sm:text-5xl xl:text-6xl">
                {t('heroTitleLead')}{' '}
                <span className="whitespace-nowrap bg-linear-to-r from-canary to-beak bg-clip-text text-transparent forced-colors:bg-none forced-colors:text-[CanvasText]">
                  {t('heroTitleEm')}
                </span>
              </h1>
              <p className="mt-5 max-w-xl text-[17px] leading-8 text-fg-muted text-pretty">{t('heroSub')}</p>

              <form
                role="search"
                aria-label={t('scan')}
                onSubmit={onSubmit}
                className="group mt-8 flex flex-col gap-2 rounded-2xl border border-field bg-panel/80 p-1.5 shadow-card transition-colors focus-within:border-canary focus-within:ring-4 focus-within:ring-canary/15 sm:flex-row sm:items-center"
              >
                <label htmlFor="scan-address" className="sr-only">
                  {t('addressLabel')}
                </label>
                <div className="flex min-w-0 flex-1 items-center">
                  <Radar className="ml-3 h-5 w-5 shrink-0 text-fg-subtle group-focus-within:text-canary" />
                  <input
                    id="scan-address"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={t('placeholder')}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    enterKeyHint="search"
                    aria-invalid={error === 'invalid'}
                    aria-describedby={error ? 'scan-error' : undefined}
                    className="h-12 min-w-0 flex-1 bg-transparent px-3 font-mono text-sm text-fg placeholder:text-fg-subtle focus:outline-hidden"
                  />
                </div>
                <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full sm:w-auto">
                  {t(loading ? 'scanning' : 'scan')}
                </Button>
              </form>

              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                <span>{t('tryLabel')}</span>
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex.value}
                    type="button"
                    disabled={loading}
                    onClick={() => void scan(ex.value)}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-panel/50 px-3 text-fg-muted transition-colors hover:border-canary/50 hover:text-fg disabled:opacity-50 sm:min-h-0 sm:py-1"
                  >
                    <span className="font-mono text-[10px] text-fg-subtle">{ex.chain}</span>
                    {t(ex.label)}
                  </button>
                ))}
              </div>

              <p className="mt-3 flex items-center gap-1.5 text-xs text-fg-subtle">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                {t('scanTrust')}
              </p>

              <p role="status" className="sr-only">
                {loading ? t('scanning') : result ? t('scanDone') : ''}
              </p>

              {error && (
                <div id="scan-error" role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-sm text-red-300">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {t(error)}
                  {error === 'networkError' && (
                    <Button size="sm" onClick={() => void scan(input)}>
                      {t('retry')}
                    </Button>
                  )}
                </div>
              )}

              <div className="mt-8 space-y-3" aria-busy={loading}>
                {loading && !result && <ResultSkeleton />}
                {result && (
                  <div className="motion-safe:animate-rise">
                    {result.chain === 'solana' ? (
                      <SolanaResult report={result.report} onScan={(a) => void scan(a)} busy={loading} />
                    ) : (
                      <EvmResult report={result.report} />
                    )}
                  </div>
                )}
                {result && (
                  <Button variant="ghost" size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copyLink()}>
                    <span aria-live="polite">{t(copyState ?? 'share')}</span>
                  </Button>
                )}
              </div>
            </div>

            <HeroRadar className="hidden lg:sticky lg:top-24 lg:block" />
          </div>
        </section>

        <StatsStrip view={canary.view} />
        <HowItWorks />

        <Section
          id="vault"
          index="02"
          eyebrow={t('vaultEyebrow')}
          title={t('vaultSectionTitle')}
          sub={t('vaultSectionSub')}
          aside={<LiveTag label="liveDevnet" />}
        >
          <Suspense fallback={<PanelFallback />}>
            <VaultPanel w={wallet} canaryTripped={tripped} />
          </Suspense>
        </Section>

        <Section
          id="bounty"
          index="03"
          eyebrow={t('bountyEyebrow')}
          title={t('canarySectionTitle')}
          sub={t('canarySectionSub')}
          aside={<LiveTag label="liveDevnet" />}
        >
          <Suspense fallback={<PanelFallback />}>
            <CanaryPanel w={wallet} view={canary.view} refresh={canary.refresh} />
          </Suspense>
        </Section>

        <Section id="qday" index="04" eyebrow={t('qdayEyebrow')} title={t('qdayTitle')} sub={t('qdaySub')}>
          <QDayClock />
        </Section>
      </main>

      <SiteFooter />
    </>
  );
}
