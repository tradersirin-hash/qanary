import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BusinessModel } from './components/BusinessModel';
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
import { SITE_URL } from './lib/links';
import { Link, parseRoute, PATHS, useRoute, type Page, type Route } from './lib/router';
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

const NAV: { page: Page; label: Key }[] = [
  { page: 'home', label: 'navScan' },
  { page: 'how', label: 'navHow' },
  { page: 'vault', label: 'navVault' },
  { page: 'bounty', label: 'navBounty' },
  { page: 'qday', label: 'navQday' },
  { page: 'roadmap', label: 'navRoadmap' },
];

/** Each page's h1 (focused after client-side navigation) and the word used in its document title. */
const PAGE_META: Record<Route, { heading: string; title: Key }> = {
  home: { heading: 'hero-title', title: 'pageTitleHome' },
  how: { heading: 'how-title', title: 'navHow' },
  vault: { heading: 'vault-title', title: 'navVault' },
  bounty: { heading: 'bounty-title', title: 'navBounty' },
  qday: { heading: 'qday-title', title: 'pageTitleQday' },
  roadmap: { heading: 'roadmap-title', title: 'navRoadmap' },
  notFound: { heading: 'notfound-title', title: 'notFoundTitle' },
};

function readQuery(): string {
  return new URLSearchParams(window.location.search).get('a') ?? '';
}

function writeQuery(value: string) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set('a', value);
  else url.searchParams.delete('a');
  url.hash = '';
  window.history.replaceState(null, '', url);
}

/** Sets (creating if needed) a <link> or <meta> in <head>; the static HTML carries none of these per-page tags. */
function setHeadTag(selector: string, create: () => HTMLElement, attr: string, value: string | null) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (value === null) {
    el?.remove();
    return;
  }
  if (!el) document.head.append((el = create()));
  el.setAttribute(attr, value);
}

function newHeadEl(tag: 'link' | 'meta', key: string, value: string) {
  const el = document.createElement(tag);
  el.setAttribute(key, value);
  return el;
}

const CANARY_PAGES: ReadonlySet<Route> = new Set(['home', 'vault', 'bounty']);

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

// The phone row fades its last 2.5rem, so links count as visible only left of the fade.
const FADE_PX = 40;

function NavLinks({ route, className, phone = false }: { route: Route; className: string; phone?: boolean }) {
  const list = useRef<HTMLUListElement>(null);
  // In the scrollable phone row, bring the current page's link into view, clear of the fade.
  useEffect(() => {
    const ul = list.current;
    const active = ul?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!ul || !active || ul.scrollWidth <= ul.clientWidth) return;
    const u = ul.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    if (a.left < u.left || a.right > u.right - FADE_PX) ul.scrollLeft += a.left - u.left - 16;
  }, [route]);
  return (
    <ul
      ref={list}
      className={className}
      // Keyboard focus on a half-faded link scrolls it fully into view (scroll padding keeps it out of the fade).
      onFocus={phone ? (e) => e.target.scrollIntoView({ block: 'nearest', inline: 'nearest' }) : undefined}
    >
      {NAV.map((n) => {
        const active = route === n.page;
        return (
          <li key={n.page} className="shrink-0">
            <Link
              to={PATHS[n.page]}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap rounded-lg px-3 text-sm hover:bg-white/[0.04] hover:text-fg',
                phone ? 'flex min-h-11 items-center' : 'block py-1.5',
                active ? 'bg-white/[0.06] text-fg' : 'text-fg-muted',
              )}
            >
              {t(n.label)}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function NotFound() {
  return (
    <Section id="notfound" eyebrow={t('notFoundEyebrow')} title={t('notFoundTitle')} sub={t('notFoundSub')}>
      <Link to={PATHS.home} className="inline-flex items-center gap-1 text-sm font-medium text-canary transition-all hover:gap-1.5">
        {t('notFoundLink')} <span aria-hidden>→</span>
      </Link>
    </Section>
  );
}

export default function App() {
  const route = useRoute();
  // A shared scan link (?a=) belongs to the scanner page only.
  const [input, setInput] = useState(() => (route === 'home' ? readQuery() : ''));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<Key | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyState, setCopyState] = useState<Key | null>(null);
  // Only the latest scan may update the page; a slower earlier scan must not overwrite it.
  const latestScan = useRef(0);
  // The last scanned address, put back into the URL (?a=) whenever the scanner page is shown again.
  const lastScanned = useRef('');
  const wallet = useWallet();
  const canary = useCanary(CANARY_PAGES.has(route));
  const tripped = knownCanary(canary.view)?.tripped ?? false;

  // A page mounts the first time it is opened and then stays mounted (hidden), so scan results,
  // an open vault and form inputs survive switching pages.
  const [visited, setVisited] = useState<ReadonlySet<Route>>(() => new Set([route]));
  if (!visited.has(route)) setVisited(new Set(visited).add(route));

  const prevRoute = useRef(route);
  // Layout effect: the jump to the top happens before the new page is painted.
  useLayoutEffect(() => {
    const meta = PAGE_META[route];
    document.title = route === 'home' ? t('pageTitleHome') : `${t(meta.title)} · ${t('pageSuffix')}`;
    const url = route === 'notFound' ? null : SITE_URL + PATHS[route];
    setHeadTag('link[rel="canonical"]', () => newHeadEl('link', 'rel', 'canonical'), 'href', url);
    setHeadTag('meta[property="og:url"]', () => newHeadEl('meta', 'property', 'og:url'), 'content', url);
    setHeadTag('meta[name="robots"]', () => newHeadEl('meta', 'name', 'robots'), 'content', route === 'notFound' ? 'noindex' : null);
    if (route === 'home' && lastScanned.current) writeQuery(lastScanned.current);
    if (prevRoute.current === route) return;
    prevRoute.current = route;
    // Client-side page change: open at the top and move focus to the new page's title for screen readers.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.getElementById(meta.heading)?.focus({ preventScroll: true });
  }, [route]);

  // Fetch the devnet panel chunks once the first page is idle, so opening Vault or Bounty later is instant.
  useEffect(() => {
    const warm = () => {
      void import('./components/VaultPanel').catch(() => {});
      void import('./components/CanaryPanel').catch(() => {});
    };
    if ('requestIdleCallback' in window) requestIdleCallback(warm);
    else setTimeout(warm, 2000);
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
    lastScanned.current = detected.value;
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
    // Shared scan links (?a=) only apply to the scanner page.
    if (initial && parseRoute(window.location.pathname) === 'home') void scan(initial);
  }, [scan]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void scan(input);
  };

  const copyLink = async () => {
    try {
      const { origin, pathname, search } = window.location;
      await navigator.clipboard.writeText(origin + pathname + search);
      setCopyState('copied');
    } catch {
      // No Clipboard API (insecure origin, in-app webview) or permission denied.
      setCopyState('copyFailed');
    }
    setTimeout(() => setCopyState(null), 2000);
  };

  const page = (r: Route, node: ReactNode) =>
    visited.has(r) || r === route ? (
      <div key={r} hidden={r !== route}>
        {node}
      </div>
    ) : null;

  return (
    <>
      <a
        href="#main"
        // Move focus without a fragment navigation, so no '#main' lands in the URL or the history.
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-canary focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink"
      >
        {t('skipToContent')}
      </a>

      <header className="sticky top-0 z-40 border-b border-line/60 bg-ink/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6 lg:px-8">
          <Link to={PATHS.home} aria-label={t('homeLabel')} className="group flex shrink-0 items-center gap-2.5">
            <img
              src="/qanary.svg"
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 transition group-hover:drop-shadow-[0_0_12px_rgb(255_210_63/0.35)]"
            />
            <span className="text-[17px] font-semibold tracking-[-0.02em]">Qanary</span>
          </Link>
          <nav aria-label={t('navLabel')} className="hidden lg:block">
            <NavLinks route={route} className="flex gap-1" />
          </nav>
          <div className="ml-auto">
            <WalletBar w={wallet} />
          </div>
        </div>
        {/* Below lg the page links get their own scrollable row, so every page is reachable on phones. */}
        <nav aria-label={t('navLabel')} className="border-t border-line/60 lg:hidden">
          <NavLinks
            phone
            route={route}
            className="mx-auto flex max-w-6xl gap-1 overflow-x-auto py-1 pl-4 pr-10 scroll-pl-4 scroll-pr-11 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] [scrollbar-width:none] sm:pl-6 sm:scroll-pl-6"
          />
        </nav>
      </header>

      <main id="main" tabIndex={-1} className="focus:outline-hidden">
        {page(
          'home',
          <>
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
                  <h1
                    id="hero-title"
                    tabIndex={-1}
                    className="mt-6 text-[2.25rem] font-semibold leading-[1.05] tracking-[-0.035em] text-balance focus:outline-hidden sm:text-5xl xl:text-6xl"
                  >
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
          </>,
        )}

        {page('how', <HowItWorks />)}

        {page(
          'vault',
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
          </Section>,
        )}

        {page(
          'bounty',
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
          </Section>,
        )}

        {page(
          'qday',
          <Section id="qday" index="04" eyebrow={t('qdayEyebrow')} title={t('qdayTitle')} sub={t('qdaySub')}>
            <QDayClock />
          </Section>,
        )}

        {page('roadmap', <BusinessModel />)}

        {page('notFound', <NotFound />)}
      </main>

      <SiteFooter />
    </>
  );
}
