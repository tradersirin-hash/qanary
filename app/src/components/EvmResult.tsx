import { t, type Key } from '../copy';
import type { EvmChainResult, EvmOverall, EvmReport } from '../lib/evm';
import { amount } from '../lib/format';
import { etherscan } from '../lib/links';
import { Badge, Card, ResultHeader, type Tone } from './ui';

const overallView: Record<EvmOverall, [Tone, Key, Key]> = {
  exposed: ['bad', 'vExposed', 'evmExposedBody'],
  notSeen: ['warn', 'vNotSeen', 'evmNotSeenBody'],
  contract: ['info', 'vContract', 'evmContractBody'],
  unknown: ['muted', 'vUnknown', 'evmUnknownBody'],
};

function rowBadge(c: EvmChainResult, overall: EvmOverall): [Tone, Key] | null {
  if (c.error || !c.status) return null;
  if (c.status === 'contract') return ['info', 'vContract'];
  // The same key is exposed everywhere once it signs on any chain.
  if (c.status === 'exposed' || c.status === 'delegated' || overall === 'exposed') return ['bad', 'vExposed'];
  return ['warn', 'vNotSeen'];
}

const TH = 'pb-2 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle';
const NUM = 'py-2.5 text-right font-mono tabular-nums whitespace-nowrap text-fg';

export function EvmResult({ report }: { report: EvmReport }) {
  const [tone, verdict, body] = overallView[report.overall];
  return (
    <Card>
      <ResultHeader title="evmTitle" address={report.address} href={etherscan(report.address)} tone={tone} verdict={verdict} />
      <p className="text-sm leading-6 text-fg-muted">{t(body)}</p>

      <div className="mt-5 overflow-x-auto" tabIndex={0} role="region" aria-label={t('evmTableCaption')}>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{t('evmTableCaption')}</caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                {t('colChain')}
              </th>
              <th scope="col" className={TH}>
                {t('colStatus')}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {t('colBalance')}
              </th>
              <th scope="col" className={`${TH} hidden text-right sm:table-cell`}>
                {t('colNonce')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {report.chains.map((c) => {
              const badge = rowBadge(c, report.overall);
              return (
                <tr key={c.chainId} className="hover:bg-white/[0.02]">
                  <td className="py-2.5 pr-3">
                    {c.explorer ? (
                      <a href={`${c.explorer}/address/${report.address}`} target="_blank" rel="noreferrer" className="text-fg hover:text-canary">
                        {c.name}
                      </a>
                    ) : (
                      c.name
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    {badge ? <Badge tone={badge[0]} label={badge[1]} /> : <span className="text-xs text-fg-subtle">{t('rpcError')}</span>}
                  </td>
                  <td className={NUM}>{c.balance !== undefined ? `${amount(Number(c.balance))} ${c.symbol}` : '–'}</td>
                  <td className={`${NUM} hidden pl-3 sm:table-cell`}>{c.nonce ?? '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-5 space-y-1 border-t border-line pt-3 text-[11px] text-fg-subtle">
        <p>{t('srcEvm', { chains: report.chains.map((c) => c.name).join(', ') })}</p>
        <p>{t('evmNativeNote')}</p>
      </div>
    </Card>
  );
}
