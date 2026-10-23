import { useState, type ComponentProps, type ReactNode } from 'react';
import { t, tOn, type Key } from '../copy';
import type { Cluster } from '../lib/cluster';
import { short } from '../lib/format';
import { explorer } from '../lib/links';
import { AlertTriangle, ArrowUpRight, Branch, Check, Copy, Info, ShieldCheck } from './icons';

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export type Tone = 'bad' | 'warn' | 'good' | 'info' | 'muted';

const toneClass: Record<Tone, string> = {
  bad: 'bg-danger/10 text-red-300 ring-danger/30',
  warn: 'bg-caution/10 text-orange-200 ring-caution/30',
  good: 'bg-safe/10 text-emerald-300 ring-safe/25',
  info: 'bg-info/10 text-sky-300 ring-info/25',
  muted: 'bg-white/5 text-fg-muted ring-white/10',
};
const toneIcon = { bad: AlertTriangle, warn: Branch, good: ShieldCheck, info: Info, muted: Info } as const;

export function Badge({
  tone,
  label,
  vars,
  size = 'md',
}: {
  tone: Tone;
  label: Key;
  vars?: Record<string, string | number>;
  size?: 'md' | 'lg';
}) {
  const Icon = toneIcon[tone];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset',
        size === 'lg' ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-1 text-xs',
        toneClass[tone],
      )}
    >
      {size === 'lg' ? <Icon className="h-3.5 w-3.5" /> : <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {t(label, vars)}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('motion-safe:animate-spin', className ?? 'h-4 w-4')}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="42 100" />
    </svg>
  );
}

const BTN_VARIANT = {
  primary: 'bg-canary text-ink shadow-glow hover:bg-canary-hover',
  secondary: 'border border-line-strong bg-panel-2 text-fg hover:border-fg-subtle hover:bg-white/[0.05]',
  ghost: 'text-fg-muted hover:bg-white/[0.04] hover:text-fg',
  danger: 'bg-danger/15 text-red-200 ring-1 ring-inset ring-danger/30 hover:bg-danger/25',
};
const BTN_SIZE = {
  // phones get 44px targets, desktop stays compact
  sm: 'h-8 min-h-11 rounded-lg px-3 text-xs sm:min-h-0',
  md: 'h-10 min-h-11 rounded-xl px-4 text-sm sm:min-h-0',
  lg: 'h-12 rounded-xl px-6 text-[15px]',
};
type ButtonProps = ComponentProps<'button'> & {
  variant?: keyof typeof BTN_VARIANT;
  size?: keyof typeof BTN_SIZE;
  loading?: boolean;
  icon?: ReactNode;
};
export function Button({ variant = 'secondary', size = 'md', loading = false, icon, className, children, type = 'button', disabled, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none',
        BTN_VARIANT[variant],
        BTN_SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function Card({ children, accent = false, className }: { children: ReactNode; accent?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        'relative rounded-card border border-line bg-panel p-5 shadow-card sm:p-6',
        accent &&
          'before:absolute before:inset-x-6 before:top-0 before:h-px before:bg-linear-to-r before:from-transparent before:via-canary/50 before:to-transparent',
        className,
      )}
    >
      {children}
    </div>
  );
}

const CALLOUT = {
  caution: { box: 'border-caution/25 bg-caution/[0.06] text-orange-100/90', icon: 'text-caution', Icon: AlertTriangle },
  danger: { box: 'border-danger/30 bg-danger/[0.07] text-red-100/90', icon: 'text-danger', Icon: AlertTriangle },
  info: { box: 'border-info/25 bg-info/[0.05] text-sky-100/90', icon: 'text-info', Icon: Info },
} as const;

export function Callout({
  tone,
  title,
  role,
  className,
  children,
}: {
  tone: keyof typeof CALLOUT;
  title?: ReactNode;
  role?: 'status' | 'alert';
  className?: string;
  children?: ReactNode;
}) {
  const { box, icon, Icon } = CALLOUT[tone];
  return (
    <div role={role} className={cn('flex gap-3 rounded-xl border p-3.5 text-[13px] leading-6', box, className)}>
      <Icon className={cn('mt-1 h-4 w-4 shrink-0', icon)} />
      <div className="min-w-0 wrap-anywhere">
        {title && <p className="font-semibold text-fg">{title}</p>}
        {children}
      </div>
    </div>
  );
}

export function Section({
  id,
  index,
  eyebrow,
  title,
  sub,
  aside,
  children,
}: {
  id: string;
  index?: string;
  eyebrow: string;
  title: string;
  sub?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  // Each Section is a whole page, so its title is the page's h1 (focused by App after client-side navigation).
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <div className="mx-auto w-full max-w-6xl px-4 pb-20 pt-14 sm:px-6 sm:pb-24 sm:pt-20 lg:px-8">
        <div className="mb-10 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="flex items-center gap-3 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-canary">
              {index && <span className="text-fg-subtle">{index}</span>}
              <span aria-hidden className="h-px w-8 bg-canary/40" />
              {eyebrow}
            </p>
            <h1
              id={`${id}-title`}
              tabIndex={-1}
              className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-balance focus:outline-hidden sm:text-4xl"
            >
              {title}
            </h1>
            {sub && <p className="mt-4 text-[15px] leading-7 text-fg-muted text-pretty">{sub}</p>}
          </div>
          {aside}
        </div>
        {children}
      </div>
    </section>
  );
}

export function StatGrid({ className, children }: { className?: string; children: ReactNode }) {
  return <dl className={cn('grid gap-px overflow-hidden rounded-xl border border-line bg-line', className)}>{children}</dl>;
}

/** `valueClass` replaces the default value style (font, size, weight, color) as a whole. */
export function Stat({ label, value, foot, valueClass }: { label: string; value: ReactNode; foot?: ReactNode; valueClass?: string }) {
  return (
    <div className="min-w-0 bg-ink-2 p-4">
      <dt className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">{label}</dt>
      <dd className={cn('mt-1.5 min-w-0 tabular-nums', valueClass ?? 'font-mono text-2xl font-medium text-fg')}>{value}</dd>
      {foot && <dd className="mt-1 text-xs leading-5 text-fg-subtle">{foot}</dd>}
    </div>
  );
}

const hostOf = (href: string) => new URL(href).hostname.replace(/^www\./, '');

/** An explorer link plus a copy button. */
export function AddressChip({ value, href, full = false }: { value: string; href: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const host = hostOf(href);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No Clipboard API (insecure origin, in-app webview) or permission denied: the link still works.
    }
  };
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-0.5 rounded-md bg-white/[0.03] py-0.5 pl-2 pr-0.5 font-mono font-normal text-fg ring-1 ring-inset ring-line',
        full ? 'text-[11px]' : 'text-[13px]',
      )}
    >
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={value}
        aria-label={t('addrLinkLabel', { value, host })}
        className="inline-flex min-w-0 items-center gap-1 hover:text-canary"
      >
        <span className={full ? 'min-w-0 break-all' : undefined}>{full ? value : short(value)}</span>
        <ArrowUpRight className="h-3 w-3 shrink-0 text-fg-subtle" />
      </a>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t(copied ? 'copiedAddress' : 'copyAddress')}
        title={t(copied ? 'copiedAddress' : 'copyAddress')}
        className="grid h-7 w-7 shrink-0 place-items-center rounded text-fg-subtle hover:bg-white/5 hover:text-fg"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-safe" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}

export function SourceLink({ url }: { url: string }) {
  const host = hostOf(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={t('sourceLabel', { host })}
      className="inline-flex items-center gap-0.5 whitespace-nowrap rounded px-1 text-[11px] font-medium text-fg-subtle hover:bg-canary/10 hover:text-canary"
    >
      {host}
      <ArrowUpRight className="h-3 w-3" />
    </a>
  );
}

export function LiveTag({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 self-start whitespace-nowrap rounded-full bg-safe/10 px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-300 ring-1 ring-inset ring-safe/25 md:self-auto">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-safe" />
      {label}
    </span>
  );
}

const WASH: Record<Tone, string> = {
  bad: 'from-danger/[0.08]',
  warn: 'from-caution/[0.07]',
  good: 'from-safe/[0.06]',
  info: 'from-info/[0.06]',
  muted: 'from-white/[0.03]',
};
const TILE: Record<Tone, string> = {
  bad: 'bg-danger/10 text-danger ring-danger/30',
  warn: 'bg-caution/10 text-caution ring-caution/30',
  good: 'bg-safe/10 text-safe ring-safe/25',
  info: 'bg-info/10 text-info ring-info/25',
  muted: 'bg-white/5 text-fg-muted ring-white/10',
};

export function ResultHeader({ title, address, href, tone, verdict }: { title: Key; address: string; href: string; tone: Tone; verdict: Key }) {
  const Icon = toneIcon[tone];
  return (
    <div
      className={cn(
        '-mx-5 -mt-5 mb-5 flex flex-wrap items-center justify-between gap-4 rounded-t-card border-b border-line bg-linear-to-r to-transparent px-5 py-4 sm:-mx-6 sm:-mt-6 sm:px-6',
        WASH[tone],
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset', TILE[tone])}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">{t(title)}</h2>
          <AddressChip value={address} href={href} />
        </div>
      </div>
      <Badge tone={tone} label={verdict} size="lg" />
    </div>
  );
}

export const FIELD =
  'h-11 w-full rounded-xl border border-field bg-ink/60 px-3.5 font-mono text-sm tabular-nums text-fg placeholder:text-fg-subtle focus:border-canary focus:outline-hidden focus:ring-4 focus:ring-canary/15 disabled:opacity-50 sm:h-10';
export const FIELD_LABEL = 'text-xs font-medium text-fg-muted';

/** Amount field with a fixed "SOL" suffix. Its accessible name comes only from the visible <label htmlFor={id}> it must be paired with. */
export function SolInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="relative w-48">
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        className={cn(FIELD, 'pr-11')}
      />
      <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-fg-subtle">
        SOL
      </span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block rounded-md bg-white/[0.05] motion-safe:animate-pulse', className)} />;
}

export type Progress = { labels: string[]; active: number };
export type Status = { tone: 'success' | 'error'; text: string; tx?: string; details?: string; link?: { href: string; label: string } };

function FeedbackBox({ status, cluster }: { status: Status; cluster: Cluster }) {
  const ok = status.tone === 'success';
  const Icon = ok ? Check : AlertTriangle;
  return (
    <div
      className={cn(
        'mt-4 flex gap-2 rounded-xl border px-3 py-2.5 text-xs leading-5 wrap-anywhere',
        ok ? 'border-safe/30 bg-safe/10 text-emerald-200' : 'border-danger/30 bg-danger/10 text-red-200',
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p>{status.text}</p>
        {status.tx && (
          <a
            href={explorer(cluster, `tx/${status.tx}`)}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:text-fg"
          >
            {tOn(cluster, 'viewTx')}
            <ArrowUpRight className="h-3 w-3" />
          </a>
        )}
        {status.link && (
          <a
            href={status.link.href}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:text-fg"
          >
            {status.link.label}
            <ArrowUpRight className="h-3 w-3" />
            <span className="sr-only"> {t('opensNewTab')}</span>
          </a>
        )}
        {status.details && (
          <details className="mt-1">
            <summary className="cursor-pointer">{t('details')}</summary>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] opacity-80">{status.details}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

/** Step list while a transaction runs, then a green or red result (its explorer link on `cluster`). The status region is always mounted. */
export function TxFeedback({ progress, status, cluster }: { progress: Progress | null; status: Status | null; cluster: Cluster }) {
  return (
    <>
      <div role="status" aria-live="polite">
        {progress && (
          <ol className="mt-4 space-y-1.5 rounded-xl border border-line bg-ink/60 px-3 py-2.5 text-xs">
            {progress.labels.map((label, i) => {
              const state = i < progress.active ? 'done' : i === progress.active ? 'active' : 'todo';
              return (
                <li
                  key={i}
                  className={cn('flex items-center gap-2', state === 'done' ? 'text-emerald-300' : state === 'active' ? 'text-fg' : 'text-fg-subtle')}
                >
                  {state === 'done' ? (
                    <Check className="h-3.5 w-3.5 shrink-0" />
                  ) : state === 'active' ? (
                    <Spinner className="h-3.5 w-3.5 shrink-0 text-canary" />
                  ) : (
                    <span aria-hidden className="grid h-3.5 w-3.5 shrink-0 place-items-center">
                      <span className="h-1 w-1 rounded-full bg-current" />
                    </span>
                  )}
                  {label}
                </li>
              );
            })}
          </ol>
        )}
        {status?.tone === 'success' && <FeedbackBox status={status} cluster={cluster} />}
      </div>
      {status?.tone === 'error' && (
        <div role="alert">
          <FeedbackBox status={status} cluster={cluster} />
        </div>
      )}
    </>
  );
}
