import { t } from '../copy';
import { Badge, cn } from './ui';

/** Decorative radar beside the hero. Captioned "Illustration": none of it is live data. */
export function HeroRadar({ className }: { className?: string }) {
  return (
    <figure aria-hidden className={cn('mx-auto w-full max-w-[420px]', className)}>
      <div className="relative aspect-square">
        <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgb(255_210_63/0.10),transparent_65%)]" />
        <svg viewBox="0 0 400 400" fill="none" stroke="currentColor" className="absolute inset-0 h-full w-full text-line-strong">
          <circle cx="200" cy="200" r="60" />
          <circle cx="200" cy="200" r="110" />
          <circle cx="200" cy="200" r="160" />
          <circle cx="200" cy="200" r="190" strokeDasharray="2 6" />
          <path d="M200 10v380M10 200h380" strokeOpacity=".5" />
        </svg>
        <div className="absolute inset-[5%] rounded-full bg-[conic-gradient(from_0deg,transparent_0_290deg,rgb(255_210_63/0.28)_360deg)] [mask-image:radial-gradient(circle,black_60%,transparent_71%)] motion-safe:animate-sweep" />
        <span className="absolute left-[66%] top-[27%] h-2 w-2 rounded-full bg-danger text-danger shadow-[0_0_14px_currentColor] motion-safe:animate-pulse" />
        <span className="absolute left-[28%] top-[60%] h-2 w-2 rounded-full bg-caution text-caution shadow-[0_0_14px_currentColor] [animation-delay:700ms] motion-safe:animate-pulse" />
        <span className="absolute left-[70%] top-[72%] h-2 w-2 rounded-full bg-safe text-safe shadow-[0_0_14px_currentColor] [animation-delay:1400ms] motion-safe:animate-pulse" />
        <div className="absolute inset-0 grid place-items-center">
          <div className="grid h-24 w-24 place-items-center rounded-3xl border border-canary/30 bg-panel shadow-glow">
            <img src="/qanary.svg" alt="" width={48} height={48} className="h-12 w-12" />
          </div>
        </div>
      </div>
      <figcaption className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Badge tone="bad" label="vExposed" />
        <Badge tone="warn" label="vProgramControlled" />
        <Badge tone="good" label="vNoAuthority" />
        <span className="w-full text-center font-mono text-[11px] uppercase tracking-[0.16em] text-fg-subtle">{t('radarCaption')}</span>
      </figcaption>
    </figure>
  );
}
