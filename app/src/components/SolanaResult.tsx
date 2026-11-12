import { t, tOn, type Key } from '../copy';
import { RECORD } from '../data/qday';
import { SHOWN_TOKENS, VAULT_CLUSTER } from '../lib/constants';
import { amount, short, usd } from '../lib/format';
import { solscan } from '../lib/links';
import { Link, PATHS } from '../lib/router';
import type { Authority, ProgramControl, SolanaReport } from '../lib/solana';
import { AddressChip, Badge, Button, Callout, Card, ResultHeader, type Tone } from './ui';
import { accountVerdict, authorityBadge, controlBadge, programVerdict, rowsVerdict, todayNote } from './verdict';
import { SolanaWalletHelp } from './WalletHelp';

const BODY = 'text-sm leading-6 text-fg-muted';
const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle';
/** The USD value sits under the amount on phones and beside it from sm up, so long numbers never overflow. */
const USD = 'block text-xs text-fg-subtle sm:ml-2 sm:inline sm:text-sm';

function AuthorityRow({
  label,
  authority,
  badge = authorityBadge(authority),
  showAddress = true,
}: {
  label: Key;
  authority: Authority | undefined;
  badge?: [Tone, Key];
  showAddress?: boolean;
}) {
  const [tone, text] = badge;
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

/** Says that the quantum-exposed keys shown above cannot be exploited today, and what an attack would need. */
function TodayNote({ authorities }: { authorities: (Authority | undefined)[] }) {
  const note = todayNote(authorities);
  return note ? <p className={`mt-3 ${BODY}`}>{t(note, { bits: RECORD.bits, target: RECORD.targetBits })}</p> : null;
}

/** Program and program-owned account cards read only the upgrade authority, never keys kept in program state. */
function NotChecked() {
  return <p className={`mt-3 ${BODY}`}>{t('notChecked')}</p>;
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
        {exposed && <SolanaWalletHelp />}
        {empty && report.tokensAvailable ? (
          <p className={`mt-4 ${BODY}`}>{t(exposed ? 'walletEmpty' : 'walletPdaEmpty')}</p>
        ) : (
          <div className="mt-5">
            <p className={EYEBROW}>{t(exposed ? 'atStake' : 'atAddress')}</p>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 font-mono text-3xl font-medium tabular-nums text-canary sm:text-4xl">
              {report.totalUsd !== undefined ? (
                <>
                  {(report.pricesPartial || !report.tokensAvailable) && (
                    <span className="font-sans text-base font-normal text-fg-muted">{t('atLeast')}</span>
                  )}
                  <span className="min-w-0 wrap-anywhere">{usd(report.totalUsd)}</span>
                </>
              ) : (
                <span className="min-w-0 wrap-anywhere">{`${amount(report.sol)} SOL`}</span>
              )}
            </p>
            {(!report.tokensAvailable || report.pricesFailed || report.symbolsFailed) && (
              <Callout tone="caution" className="mt-3">
                {!report.tokensAvailable && <p>{t('tokensUnavailable')}</p>}
                {report.pricesFailed && <p>{t(report.totalUsd !== undefined ? 'pricesFailed' : 'pricesUnavailable')}</p>}
                {report.symbolsFailed && <p>{t('symbolsUnavailable')}</p>}
              </Callout>
            )}
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
            {report.pricesPartial && report.totalUsd !== undefined && !report.pricesFailed && (
              <p className="mt-2 text-xs text-fg-subtle">{t('pricesPartial')}</p>
            )}
          </div>
        )}
        {exposed && !empty && (
          <p className="mt-5 border-t border-line pt-4 text-sm text-fg-muted">
            {t('bridgeVault')}{' '}
            <Link to={PATHS.vault} className="font-medium text-canary hover:underline">
              {tOn(VAULT_CLUSTER, 'bridgeVaultLink')} <span aria-hidden>→</span>
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
        <TodayNote authorities={[controlAuthority(report.control)]} />
        {report.control !== 'closed' && <NotChecked />}
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
        <TodayNote authorities={report.rows.map((r) => r.authority)} />
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
  const [tone, verdict] = accountVerdict(report.ownerControl);
  return (
    <Card>
      <ResultHeader title="accountTitle" address={report.address} href={solscan(report.address)} tone={tone} verdict={verdict} />
      <p className={BODY}>{t('accountBody')}</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="text-sm text-fg-muted">{t('ownerProgram')}</span>
        <AddressChip value={report.owner} href={solscan(report.owner)} />
      </div>
      <AuthorityRow label="ownerUpgrade" authority={ownerAuthority} badge={controlBadge(report.ownerControl)} />
      <TodayNote authorities={[ownerAuthority]} />
      <NotChecked />
      <SourceLine />
    </Card>
  );
}
