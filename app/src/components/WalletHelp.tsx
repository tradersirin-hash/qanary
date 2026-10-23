import { Fragment, type ReactNode } from 'react';
import { t, type Key } from '../copy';
import { RECORD } from '../data/qday';
import { Link, PATHS } from '../lib/router';

const LINK = 'font-medium text-canary hover:underline';
const record = () => t('helpRecord', { bits: RECORD.bits, target: RECORD.targetBits });

/** Fills {name} placeholders in a copy string with elements, such as in-text links. */
function rich(key: Key, parts: Record<string, ReactNode>) {
  return t(key)
    .split(/\{(\w+)\}/)
    .map((piece, i) => <Fragment key={i}>{i % 2 ? parts[piece] : piece}</Fragment>);
}

/** A collapsed "What can I do?" answer under an exposed-wallet verdict. */
function HelpDetails({ items }: { items: ReactNode[] }) {
  return (
    <details className="mt-4 rounded-xl border border-line bg-ink/40 p-4">
      <summary className="cursor-pointer text-sm font-medium text-fg">{t('helpTitle')}</summary>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-fg-muted">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2.5">
            <span aria-hidden className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-fg-subtle" />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function SolanaWalletHelp() {
  return (
    <HelpDetails
      items={[
        t('helpSolCalm'),
        record(),
        t('helpSolPlan'),
        rich('helpSolWatch', {
          canary: (
            <Link to={PATHS.bounty} className={LINK}>
              {t('helpCanaryLink')}
            </Link>
          ),
          vault: (
            <Link to={PATHS.vault} className={LINK}>
              {t('helpVaultLink')}
            </Link>
          ),
        }),
      ]}
    />
  );
}

export function EvmWalletHelp() {
  return <HelpDetails items={[`${t('helpEvmCalm')} ${record()}`, t('helpEvmWhy'), t('helpEvmMove')]} />;
}
