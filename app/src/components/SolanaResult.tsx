import { t, type Key } from '../copy';
import { SHOWN_TOKENS } from '../lib/constants';
import { amount, short, usd } from '../lib/format';
import { solscan } from '../lib/links';
import { Link, PATHS } from '../lib/router';
import type { Authority, ControlRow, ProgramControl, SolanaReport } from '../lib/solana';
import { AddressChip, Badge, Button, Callout, Card, ResultHeader, type Tone } from './ui';

const BODY = 'text-sm leading-6 text-fg-muted';
const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle';
/** The USD value sits under the amount on phones and beside it from sm up, so long numbers never overflow. */
const USD = 'block text-xs text-fg-subtle sm:ml-2 sm:inline sm:text-sm';

function authorityBadge(authority: Authority | undefined): [Tone, Key] {
  if (authority === undefined) return ['muted', 'vUnknown'];
  if (authority === null) return ['good', 'authNone'];
  if (authority.multisig) return authority.kind === 'exposed' ? ['bad', 'authMultisigExposed'] : ['warn', 'authMultisigPda'];
  return authority.kind === 'exposed' ? ['bad', 'authExposed'] : ['warn', 'authPda'];
}

function AuthorityRow({ label, authority, showAddress = true }: { label: Key; authority: Authority | undefined; showAddress?: boolean }) {
  const [tone, text] = authorityBadge(authority);
  const multisig = authority?.multisig;
  const counts = multisig && { m: multisig.m, n: multisig.signers.length };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-3 first:border-t-0">
      <span className="text-sm text-fg-muted">{t(label)}</span>
      <span className="flex flex-wrap items-center gap-2">
        {authority && showAddress && <AddressChip value={authority.address} href={solscan(authority.address)} />}
        <Badge tone={tone} label={text} vars={counts} />
      </span>
      {multisig && (
        <div className="flex w-full flex-wrap items-center gap-2 pt-1">
          <span className="text-xs text-fg-subtle">{t('multisigSigners', counts)}</span>
          {multisig.signers.map((s, i) => (
            // A multisig may list the same signer twice; each slot counts on-chain.
            <span key={`${i}-${s.address}`} className="inline-flex max-w-full flex-wrap items-center gap-1.5">
              <AddressChip value={s.address} href={solscan(s.address)} />
              {s.kind === 'pda' && <Badge tone="warn" label="vPda" />}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SourceLine() {
  return <p className="mt-5 border-t border-line pt-3 text-[11px] text-fg-subtle">{t('srcSolana')}</p>;
}

/** Worst case among the rows that can move funds or change supply. */
function rowsVerdict(rows: ControlRow[]): [Tone, Key] {
  const critical = rows.filter((r) => r.critical);
  if (critical.some((r) => r.authority?.kind === 'exposed')) return ['bad', 'vExposed'];
  if (critical.some((r) => r.authority?.kind === 'pda')) return ['warn', 'vProgramControlled'];
  return ['good', 'vNoAuthority'];
}

function programVerdict(control: ProgramControl): [Tone, Key, Key] {
  if (control === undefined) return ['muted', 'vUnknown', 'upgradeUnknown'];
  if (control === 'closed') return ['muted', 'vClosed', 'programClosed'];
  if (control === 'builtin') return ['good', 'vBuiltin', 'programBuiltin'];
  if (control === null) return ['good', 'vImmutable', 'upgradeNone'];
  return control.kind === 'exposed' ? ['bad', 'vExposed', 'upgradeExposed'] : ['warn', 'vProgramControlled', 'upgradePda'];
}

function controlAuthority(control: ProgramControl): Authority | undefined {
  return control === 'closed' || control === 'builtin' ? null : control;
}

export function SolanaResult({ report, onScan, busy }: { report: SolanaReport; onScan: (addr: string) => void; busy: boolean }) {
  if (report.kind === 'wallet') {
    const exposed = report.key === 'exposed';
    const empty = report.sol === 0 && report.tokens.length === 0;
    const hidden = report.tokens.length - SHOWN_TOKENS;
    return (
      <Card>
        <ResultHeader
          title="walletTitle"
          address={report.address}
          href={solscan(report.address)}
          tone={exposed ? 'bad' : 'warn'}
          verdict={exposed ? 'vExposed' : 'vPda'}
        />
        <p className={BODY}>{t(exposed ? 'walletExposedBody' : 'walletPdaBody')}</p>
        {empty && report.tokensAvailable ? (
          <p className={`mt-4 ${BODY}`}>{t(exposed ? 'walletEmpty' : 'walletPdaEmpty')}</p>
        ) : (
          <div className="mt-5">
            <p className={EYEBROW}>{t(exposed ? 'atStake' : 'atAddress')}</p>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 font-mono text-3xl font-medium tabular-nums text-canary sm:text-4xl">
              {report.totalUsd !== undefined ? (
                <>
                  {report.pricesPartial && <span className="font-sans text-base font-normal text-fg-muted">{t('atLeast')}</span>}
                  <span className="min-w-0 wrap-anywhere">{usd(report.totalUsd)}</span>
                </>
              ) : (
                <span className="min-w-0 wrap-anywhere">{`${amount(report.sol)} SOL`}</span>
              )}
            </p>
            <ul className="mt-4 divide-y divide-line text-sm">
              <li className="flex items-center justify-between gap-4 py-2.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/5 text-[10px] font-semibold text-fg-muted">
                    S
                  </span>
                  SOL
                </span>
                <span className="shrink-0 text-right font-mono tabular-nums text-fg">
                  {amount(report.sol)}
                  {report.solUsd !== undefined && <span className={USD}>{usd(report.solUsd)}</span>}
                </span>
              </li>
              {report.tokens.slice(0, SHOWN_TOKENS).map((tk) => (
                <li key={tk.mint} className="flex items-center justify-between gap-4 py-2.5">
                  <span className="flex min-w-0 items-center gap-2" title={`${tk.name ?? ''} ${tk.mint}`.trim()}>
                    <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/5 text-[10px] font-semibold text-fg-muted">
                      {(tk.symbol ?? '?')[0]}
                    </span>
                    <span className="truncate">{tk.symbol ?? <span className="font-mono">{short(tk.mint)}</span>}</span>
                    {tk.verified === false && <Badge tone="muted" label="unverified" />}
                  </span>
                  <span className="shrink-0 text-right font-mono tabular-nums text-fg">
                    {amount(tk.uiAmount)}
                    <span className={USD}>{tk.usd !== undefined ? usd(tk.usd) : t('priceNA')}</span>
                  </span>
                </li>
              ))}
            </ul>
            {hidden > 0 && <p className="mt-2 text-xs text-fg-subtle">{t('moreTokens', { n: hidden })}</p>}
            {report.pricesPartial && report.totalUsd !== undefined && <p className="mt-2 text-xs text-fg-subtle">{t('pricesPartial')}</p>}
            {!report.tokensAvailable && (
              <Callout tone="caution" className="mt-3">
                {t('tokensUnavailable')}
              </Callout>
            )}
          </div>
        )}
        {exposed && !empty && (
          <p className="mt-5 border-t border-line pt-4 text-sm text-fg-muted">
            {t('bridgeVault')}{' '}
            <Link to={PATHS.vault} className="font-medium text-canary hover:underline">
              {t('bridgeVaultLink')} <span aria-hidden>→</span>
            </Link>
          </p>
        )}
        <SourceLine />
      </Card>
    );
  }

  if (report.kind === 'program') {
    const [tone, verdict, body] = programVerdict(report.control);
    return (
      <Card>
        <ResultHeader title="programTitle" address={report.address} href={solscan(report.address)} tone={tone} verdict={verdict} />
        {report.control !== 'closed' && report.control !== 'builtin' && <AuthorityRow label="upgradeAuthority" authority={report.control} />}
        <p className={`mt-3 ${BODY}`}>{t(body)}</p>
        <SourceLine />
      </Card>
    );
  }

  if (report.kind === 'controlled') {
    const [tone, verdict] = rowsVerdict(report.rows);
    return (
      <Card>
        <ResultHeader title={report.title} address={report.address} href={solscan(report.address)} tone={tone} verdict={verdict} />
        <p className={`mb-3 ${BODY}`}>{t(report.body)}</p>
        {report.rows.map((row) => (
          <AuthorityRow key={row.label} label={row.label} authority={row.authority} showAddress={row.label !== 'rowSigners'} />
        ))}
        {report.sol !== undefined && report.sol > 0 && <p className="mt-3 font-mono text-sm tabular-nums text-fg-muted">{amount(report.sol)} SOL</p>}
        {report.scanTarget && (
          <Button variant="primary" size="sm" disabled={busy} className="mt-4" onClick={() => onScan(report.scanTarget!)}>
            {t('scanOwner')}
          </Button>
        )}
        <SourceLine />
      </Card>
    );
  }

  const ownerAuthority = controlAuthority(report.ownerControl);
  const exposed = ownerAuthority?.kind === 'exposed';
  return (
    <Card>
      <ResultHeader
        title="accountTitle"
        address={report.address}
        href={solscan(report.address)}
        tone={exposed ? 'bad' : 'info'}
        verdict={exposed ? 'vExposed' : 'vProgramControlled'}
      />
      <p className={BODY}>{t('accountBody')}</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="text-sm text-fg-muted">{t('ownerProgram')}</span>
        <AddressChip value={report.owner} href={solscan(report.owner)} />
      </div>
      <AuthorityRow label="ownerUpgrade" authority={ownerAuthority} />
      <SourceLine />
    </Card>
  );
}
