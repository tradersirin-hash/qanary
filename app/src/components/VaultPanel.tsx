import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { address, lamports, type Address } from '@solana/kit';
import { useState } from 'react';
import { DEPLOYMENT, t, tOn, type Key } from '../copy';
import { NETWORKS, VAULT_CLUSTER } from '../lib/constants';
import { friendlyError, isRejection, UserFacingError } from '../lib/errors';
import { amount, exactSol, short } from '../lib/format';
import * as lmots from '../lib/lmots';
import { quizPassed, quizPositions } from '../lib/phraseQuiz';
import { explorer } from '../lib/links';
import {
  canaryAddress,
  checkWithdraw,
  computeLimitIx,
  createVaultIx,
  deriveKeys,
  fetchVault,
  isValidPhrase,
  KeyAlreadyUsed,
  MaybeLanded,
  oneTimeSignature,
  parseSol,
  pendingFor,
  PQ_COMPUTE_UNITS,
  pqSetOwnerIx,
  pqWithdrawSolIx,
  rpc,
  send,
  setOwnerMessage,
  toHex,
  transferIx,
  vaultAddress,
  withdrawSolIx,
  withdrawSolMessage,
  type SendStep,
  type SignedRequest,
  type VaultKeys,
  type VaultState,
} from '../lib/qanary';
import type { WalletState } from '../lib/useWallet';
import { ArrowUpRight } from './icons';
import {
  AddressChip,
  Button,
  Callout,
  Card,
  cn,
  FIELD,
  FIELD_LABEL,
  SolInput,
  Stat,
  StatGrid,
  TxFeedback,
  type Progress,
  type Status,
} from './ui';

const sameBytes = (a: Uint8Array, b: Uint8Array) => toHex(a) === toHex(b);
const CHECK_ERRORS: Record<'amount' | 'balance' | 'destination' | 'rent', Key> = {
  amount: 'badAmount',
  balance: 'badBalance',
  destination: 'badDestination',
  rent: 'badRent',
};
const sol = (lamportsValue: bigint) => amount(Number(lamportsValue) / 1e9);
/** Copy for a sentence that names the vault's cluster. */
const tv = (key: Key, vars?: Record<string, string | number>) => tOn(VAULT_CLUSTER, key, vars);

/** Lets React paint the current step label before synchronous hashing (BIP-39, LM-OTS) blocks the thread.
 *  requestAnimationFrame never fires in a background tab, so a short timeout makes sure the flow never stalls. */
const paint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 100);
  });

/** Human-readable form of a signed request, with the exact amount and full addresses so the user can verify them. */
function summarize(r: SignedRequest): string {
  if (r.kind === 'withdrawSol') return t('summaryWithdraw', { amount: exactSol(BigInt(r.amount)), destination: r.destination });
  return r.owner ? t('summaryOwnerOn', { owner: r.owner }) : t('summaryOwnerOff');
}

function sameRequest(a: SignedRequest | null, b: SignedRequest | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'setOwner' && b.kind === 'setOwner') return a.owner === b.owner;
  if (a.kind === 'withdrawSol' && b.kind === 'withdrawSol') return a.destination === b.destination && a.amount === b.amount;
  return false;
}

/** Decorative: used keys (up to 15, then +n), the current key, and the next three. The `nextKey` foot carries the text. */
function KeyChain({ nonce }: { nonce: number }) {
  const shown = Math.min(nonce, 15);
  return (
    <ol aria-hidden className="mt-2 flex flex-wrap items-center gap-1">
      {Array.from({ length: shown }, (_, i) => (
        <li key={`used-${i}`} className="h-2.5 w-5 rounded-sm bg-fg-subtle/40" />
      ))}
      {nonce > shown && <li className="font-mono text-[10px] leading-none text-fg-subtle">+{nonce - shown}</li>}
      <li className="h-2.5 w-5 rounded-sm bg-canary shadow-[0_0_8px_rgb(255_210_63/0.6)] motion-safe:animate-pulse" />
      {[0, 1, 2].map((i) => (
        <li key={`next-${i}`} className="h-2.5 w-5 rounded-sm ring-1 ring-inset ring-line-strong" />
      ))}
    </ol>
  );
}

/** Decorative: the 26 Winternitz hash chains of one LM-OTS signature. */
function HashChainArt() {
  return (
    <div>
      <div
        aria-hidden
        className="relative h-56 overflow-hidden rounded-xl border border-line bg-ink/60 p-4 [mask-image:linear-gradient(to_bottom,transparent,black_15%,black_85%,transparent)]"
      >
        <div className="grid h-full grid-cols-26 gap-1 sm:gap-1.5">
          {Array.from({ length: lmots.P }, (_, i) => (
            <div key={i} className="relative overflow-hidden rounded-full bg-line/50">
              <span
                className="absolute inset-x-0 top-0 h-1/4 rounded-full bg-linear-to-b from-transparent to-canary motion-safe:animate-chain"
                style={{ animationDelay: `${((i * 37) % 26) / 10}s` }}
              />
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 font-mono text-[11px] text-fg-subtle">{t('chainCaption')}</p>
    </div>
  );
}

type Mode = 'idle' | 'create' | 'open';
type Task = (go: (i: number) => void) => Promise<Status | void>;
/** A request key #0 already signed for a vault that does not exist yet (an earlier create was cancelled in the wallet). */
type CreatePending = { request: SignedRequest; keys: VaultKeys; vault: Address };

export function VaultPanel({ w, canaryTripped }: { w: WalletState; canaryTripped: boolean }) {
  const [mode, setMode] = useState<Mode>('idle');
  const [phrase, setPhrase] = useState('');
  const [saved, setSaved] = useState(false);
  /** Word positions (0-based) the user must type back from their written copy, and what they typed. */
  const [quiz, setQuiz] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [allowWallet, setAllowWallet] = useState(false);
  const [keys, setKeys] = useState<VaultKeys | null>(null);
  const [vault, setVault] = useState<VaultState | null>(null);
  const [depositAmount, setDepositAmount] = useState('0.5');
  const [withdrawAmount, setWithdrawAmount] = useState('0.1');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pending, setPending] = useState<{ nonce: number; request: SignedRequest } | null>(null);
  const [createPending, setCreatePending] = useState<CreatePending | null>(null);

  const wallet = w.wallet;
  const account = w.account;
  const payer = account ? address(account.address) : null;
  const walletName = wallet?.name ?? t('yourWallet');
  const foreignOwner = !!(vault?.owner && payer && vault.owner !== payer);

  /** Reads the vault and derives the pending panel from storage, so it survives wallet rejections and reloads. */
  const reload = async (k: VaultKeys) => {
    const v = await fetchVault(await vaultAddress(k));
    setVault(v);
    const p = v ? pendingFor(v.address, v.nonce) : null;
    setPending(p && v ? { nonce: v.nonce, request: p } : null);
    return v;
  };

  /** Runs one wallet action: busy is set at click time (no double sends), with step progress and friendly errors. */
  const run = async (id: string, labels: string[], task: Task) => {
    if (!wallet || !account) return setStatus({ tone: 'error', text: tv('connectFirst') });
    setBusy(id);
    setStatus(null);
    setProgress(labels.length ? { labels, active: 0 } : null);
    const go = (i: number) => setProgress({ labels, active: i });
    try {
      setStatus((await task(go)) ?? null);
    } catch (e) {
      if (e instanceof KeyAlreadyUsed) {
        if (keys) setPending({ nonce: e.nonce, request: e.pending });
        else setStatus({ tone: 'error', text: e.message });
      } else if (e instanceof MaybeLanded) setStatus({ tone: 'error', text: e.message, tx: e.signature });
      else setStatus({ tone: 'error', ...friendlyError(e, VAULT_CLUSTER) });
    } finally {
      setProgress(null);
      if (keys) await reload(keys).catch(() => undefined);
      setBusy(null);
    }
  };

  const approveLabel = t('stepApprove', { wallet: walletName });
  const stepOf = (approveIndex: number) => (go: (i: number) => void) => (s: SendStep) => go(s === 'approve' ? approveIndex : approveIndex + 1);

  const startCreate = () => {
    setPhrase(generateMnemonic(wordlist, 256));
    setSaved(false);
    const positions = quizPositions(24);
    setQuiz(positions);
    setAnswers(positions.map(() => ''));
    setAllowWallet(false);
    setCreatePending(null);
    setMode('create');
    setStatus(null);
  };

  const startOpen = () => {
    setMode('open');
    setPhrase('');
    setStatus(null);
  };

  const cancelMode = () => {
    setMode('idle');
    setPhrase('');
    setCreatePending(null);
    setStatus(null);
  };

  /** Signs a request with the vault's current one-time key and builds its instruction. */
  const pqInstruction = async (v: VaultState, k: VaultKeys, request: SignedRequest) => {
    const nextKey = lmots.publicKey(k.id, v.nonce + 1, k.seed);
    if (request.kind === 'withdrawSol') {
      const dest = address(request.destination);
      const value = BigInt(request.amount);
      const signature = await oneTimeSignature(k, v, withdrawSolMessage(v.address, v.nonce, nextKey, dest, value), request);
      return pqWithdrawSolIx(v.address, dest, signature, value, nextKey);
    }
    const owner = request.owner ? address(request.owner) : null;
    const signature = await oneTimeSignature(k, v, setOwnerMessage(v.address, v.nonce, nextKey, owner), request);
    return pqSetOwnerIx(v.address, signature, owner, nextKey);
  };

  const openCreated = async (k: VaultKeys) => {
    setKeys(k);
    setMode('idle');
    setPhrase('');
    setCreatePending(null);
    await reload(k).catch(() => undefined);
  };

  /** Creates the vault; with `request` (always a setOwner), key #0 adds wallet access in the same transaction. */
  const submitCreate = async (k: VaultKeys, vaultAddr: Address, request: SignedRequest | null, go: (i: number) => void, approveIndex: number): Promise<Status> => {
    const ixs = [computeLimitIx(PQ_COMPUTE_UNITS), createVaultIx(payer!, vaultAddr, k)];
    if (request) {
      // Key 0 adds the wallet as owner in the same transaction; the program never accepts an unsigned owner.
      const fresh: VaultState = { address: vaultAddr, id: k.id, genesisKey: k.genesisKey, key: k.genesisKey, nonce: 0, owner: null, lamports: 0n, spendable: 0n };
      ixs.push(await pqInstruction(fresh, k, request));
    }
    try {
      const sig = await send(VAULT_CLUSTER, wallet!, account!, ixs, stepOf(approveIndex)(go));
      await openCreated(k);
      return { tone: 'success', text: tv('createdOk'), tx: sig };
    } catch (e) {
      // Someone may have created this exact vault first; that is harmless if it is untouched.
      const existing = await fetchVault(vaultAddr).catch(() => null);
      if (existing && sameBytes(existing.genesisKey, k.genesisKey)) {
        await openCreated(k);
        return { tone: 'success', text: t('vaultExisted') };
      }
      if (request && isRejection(e)) {
        // Key #0 has signed: from now on it may only ever send this exact request.
        setCreatePending({ request, keys: k, vault: vaultAddr });
        throw new UserFacingError(t('walletCancelledAfterSign', { n: 0 }));
      }
      throw e;
    }
  };

  const create = () => {
    const withAccess = allowWallet;
    const labels = withAccess
      ? [t('stepKeys'), t('stepSignAccess'), approveLabel, tv('stepConfirm')]
      : [t('stepKeys'), approveLabel, tv('stepConfirm')];
    return run('create', labels, async (go) => {
      await paint();
      const k = deriveKeys(phrase, VAULT_CLUSTER);
      const vaultAddr = await vaultAddress(k);
      const wanted: SignedRequest | null = withAccess ? { kind: 'setOwner', owner: payer! } : null;
      const prior = pendingFor(vaultAddr, 0);
      if (prior && !sameRequest(prior, wanted)) {
        // Key #0 already signed something else (e.g. wallet access, then the wallet popup was rejected).
        // Never sign a second request with it: show the signed one and let the user re-send or cancel.
        const existing = await fetchVault(vaultAddr);
        if (existing && sameBytes(existing.genesisKey, k.genesisKey)) {
          await openCreated(k);
          return { tone: 'success', text: t('vaultExisted') };
        }
        setCreatePending({ request: prior, keys: k, vault: vaultAddr });
        return;
      }
      if (withAccess) {
        go(1);
        await paint();
      }
      return submitCreate(k, vaultAddr, wanted, go, withAccess ? 2 : 1);
    });
  };

  /** Creates the vault with the request key #0 already signed. oneTimeSignature returns the stored bytes: no new signature. */
  const resendCreate = () => {
    if (!createPending) return;
    const { request, keys: k, vault: vaultAddr } = createPending;
    return run('resendCreate', [t('stepCheck'), approveLabel, tv('stepConfirm')], (go) => submitCreate(k, vaultAddr, request, go, 1));
  };

  const openExisting = async () => {
    if (!isValidPhrase(phrase)) return setStatus({ tone: 'error', text: t('invalidPhrase') });
    setBusy('open');
    setStatus(null);
    try {
      await paint();
      const k = deriveKeys(phrase, VAULT_CLUSTER);
      const v = await reload(k);
      if (!v) return setStatus({ tone: 'error', text: tv('noVaultFound') });
      if (!sameBytes(lmots.publicKey(k.id, v.nonce, k.seed), v.key)) return setStatus({ tone: 'error', text: tv('keyMismatch') });
      setKeys(k);
      setMode('idle');
      setPhrase('');
    } catch (e) {
      setStatus({ tone: 'error', ...friendlyError(e, VAULT_CLUSTER) });
    } finally {
      setBusy(null);
    }
  };

  /** Signs `request` with the current one-time key and sends it. A wallet rejection after signing leaves it pending. */
  const signAndSendPq = async (v: VaultState, request: SignedRequest, go: (i: number) => void) => {
    go(1);
    await paint();
    const ix = await pqInstruction(v, keys!, request);
    try {
      return await send(VAULT_CLUSTER, wallet!, account!, [computeLimitIx(PQ_COMPUTE_UNITS), ix], stepOf(2)(go));
    } catch (e) {
      if (isRejection(e)) throw new UserFacingError(t('walletCancelledAfterSign', { n: v.nonce }));
      throw e;
    }
  };

  /** Re-reads an open vault that could not be read yet (e.g. a public RPC node lagging right after create). No wallet needed. */
  const reloadVault = async () => {
    if (!keys) return;
    setBusy('reload');
    setStatus(null);
    try {
      if (!(await reload(keys))) setStatus({ tone: 'error', text: t('vaultStillMissing') });
    } catch (e) {
      setStatus({ tone: 'error', ...friendlyError(e, VAULT_CLUSTER) });
    } finally {
      setBusy(null);
    }
  };

  /** Leaves an open vault that could not be read; the phrase can open it again later. */
  const closeUnread = () => {
    setKeys(null);
    setVault(null);
    setPending(null);
    setStatus(null);
  };

  const freshVault = async () => {
    const v = await reload(keys!);
    if (!v) throw new UserFacingError(tv('noVaultFound'));
    return v;
  };

  const withdrawPq = () =>
    run('withdrawPq', [t('stepCheck'), t('stepSign', { n: vault?.nonce ?? 0 }), approveLabel, tv('stepConfirm')], async (go) => {
      const v = await freshVault();
      const check = await checkWithdraw(v, withdrawAmount, destination.trim() || account!.address);
      if (!check.ok) return { tone: 'error', text: t(CHECK_ERRORS[check.reason]) };
      const tx = await signAndSendPq(v, { kind: 'withdrawSol', destination: check.destination, amount: check.lamports.toString() }, go);
      return { tone: 'success', text: t('withdrawPqOk', { amount: sol(check.lamports), n: v.nonce, next: v.nonce + 1 }), tx };
    });

  const removeWallet = () =>
    run('removeWallet', [t('stepCheck'), t('stepSign', { n: vault?.nonce ?? 0 }), approveLabel, tv('stepConfirm')], async (go) => {
      const v = await freshVault();
      const tx = await signAndSendPq(v, { kind: 'setOwner', owner: null }, go);
      return { tone: 'success', text: t('removeWalletOk'), tx };
    });

  /** Re-sends the request the current key already signed. With the nonce moved on, it already landed. */
  const resend = () => {
    if (!pending) return;
    const { nonce, request } = pending;
    return run('resend', [t('stepCheck'), approveLabel, tv('stepConfirm')], async (go) => {
      const v = await freshVault();
      if (v.nonce !== nonce) return { tone: 'success', text: t('pendingLanded', { n: nonce }) };
      const tx = await send(VAULT_CLUSTER, wallet!, account!, [computeLimitIx(PQ_COMPUTE_UNITS), await pqInstruction(v, keys!, request)], stepOf(1)(go));
      const text =
        request.kind === 'withdrawSol'
          ? t('withdrawPqOk', { amount: sol(BigInt(request.amount)), n: v.nonce, next: v.nonce + 1 })
          : request.owner
            ? t('accessOnOk', { owner: short(request.owner) })
            : t('removeWalletOk');
      return { tone: 'success', text, tx };
    });
  };

  const withdrawWallet = () =>
    run('withdrawWallet', [t('stepCheck'), approveLabel, tv('stepConfirm')], async (go) => {
      const v = await freshVault();
      const check = await checkWithdraw(v, withdrawAmount, destination.trim() || account!.address);
      if (!check.ok) return { tone: 'error', text: t(CHECK_ERRORS[check.reason]) };
      const tx = await send(VAULT_CLUSTER, wallet!, account!, [withdrawSolIx(v.address, payer!, check.destination, await canaryAddress(), check.lamports)], stepOf(1)(go));
      return { tone: 'success', text: t('withdrawWalletOk', { amount: sol(check.lamports) }), tx };
    });

  const deposit = () => {
    const value = parseSol(depositAmount);
    if (!value) return setStatus({ tone: 'error', text: t('badAmount') });
    return run('deposit', [t('stepApproveTx', { wallet: walletName }), tv('stepConfirm')], async (go) => {
      const tx = await send(VAULT_CLUSTER, wallet!, account!, [transferIx(payer!, vault!.address, value)], stepOf(0)(go));
      return { tone: 'success', text: t('depositOk', { amount: sol(value) }), tx };
    });
  };

  const airdrop = () =>
    run('airdrop', [], async () => {
      try {
        await rpc(VAULT_CLUSTER).requestAirdrop(payer!, lamports(1_000_000_000n)).send();
      } catch {
        throw new UserFacingError(t('airdropFailed'));
      }
      return { tone: 'success', text: t('airdropOk') };
    });

  // Devnet only: mainnet has no faucet.
  const airdropButton = payer && NETWORKS[VAULT_CLUSTER].airdrop && (
    <Button variant="ghost" size="sm" loading={busy === 'airdrop'} disabled={!!busy} onClick={() => void airdrop()}>
      {t('getDevnetSol')}
    </Button>
  );

  const pendingCopy = (request: SignedRequest) => (
    <>
      <p>{t('pendingBody', { summary: summarize(request) })}</p>
      {request.kind === 'setOwner' && request.owner && payer && request.owner !== payer && (
        <p className="mt-1 font-medium text-fg">{t('pendingOtherWallet')}</p>
      )}
      <p className="mt-1">{t('pendingExplain')}</p>
    </>
  );

  const locked = !!busy || !!pending;
  const wordCount = mode === 'open' && phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
  const phraseValid = wordCount === 24 && isValidPhrase(phrase);

  return (
    <div className="space-y-4">
      <Callout tone="caution" title={t(VAULT_CLUSTER === 'devnet' ? 'devnetBannerTitle' : 'mainnetBannerTitle')}>
        {t(VAULT_CLUSTER === 'devnet' ? 'devnetBanner' : 'mainnetBanner')}
        {/* Set only when the Bounty runs on another cluster: which canary this vault follows. */}
        {DEPLOYMENT.vaultCanary && ` ${DEPLOYMENT.vaultCanary}`}
      </Callout>

      <Card accent>
        {!keys && mode === 'idle' && (
          <div className="grid gap-8 md:grid-cols-2 md:items-center">
            <div>
              <ol className="mb-5 grid gap-2 text-sm leading-6 text-fg-muted sm:grid-cols-3 md:grid-cols-1">
                {(['vaultStep1', 'vaultStep2', 'vaultStep3'] as const).map((k, i) => (
                  <li key={k} className="flex gap-2">
                    <span className="font-mono text-fg-subtle">{i + 1}.</span>
                    <span>{tv(k)}</span>
                  </li>
                ))}
              </ol>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" size="lg" disabled={!account} onClick={startCreate}>
                  {t('createVault')}
                </Button>
                <Button size="lg" onClick={startOpen}>
                  {t('openVault')}
                </Button>
                {airdropButton}
              </div>
              {!account && (
                <p className="mt-3 text-xs leading-5 text-fg-subtle">
                  {tv('needWalletToCreate')} {t('openNoWallet')}
                </p>
              )}
            </div>
            <HashChainArt />
          </div>
        )}

        {mode === 'create' && (
          <div>
            <h2 className="text-base font-semibold tracking-tight">{t('phraseTitle')}</h2>
            <Callout tone="caution" className="mt-3">
              {t('phraseWarn')}
            </Callout>
            {!saved && (
              <ol className="mt-4 grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                {phrase.split(' ').map((word, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-lg bg-ink/60 px-2.5 py-2 font-mono text-[13px] ring-1 ring-inset ring-line">
                    <span aria-hidden className="w-5 text-right tabular-nums text-fg-subtle">
                      {i + 1}
                    </span>
                    {word}
                  </li>
                ))}
              </ol>
            )}
            <label className="mt-5 flex items-start gap-2.5 text-sm text-fg">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-canary" />
              {t('phraseSaved')}
            </label>
            {saved && (
              <fieldset className="mt-4 rounded-xl bg-ink/40 p-4 ring-1 ring-inset ring-line">
                <legend className="px-1 text-sm font-semibold text-fg">{t('quizTitle')}</legend>
                <p className="text-sm leading-6 text-fg-muted">{t('quizBody')}</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {quiz.map((position, i) => {
                    const typed = answers[i] ?? '';
                    const wrong = typed.trim() !== '' && !quizPassed(phrase, [position], [typed]);
                    return (
                      <label key={position} className="text-xs font-medium text-fg-muted">
                        {t('quizWord', { n: position + 1 })}
                        <input
                          value={typed}
                          onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          autoComplete="off"
                          aria-invalid={wrong}
                          className={cn(
                            'mt-1 w-full rounded-lg border bg-ink/60 px-3 py-2 font-mono text-sm text-fg focus:outline-hidden focus:ring-4',
                            wrong ? 'border-red-400/70 focus:ring-red-400/15' : 'border-field focus:border-canary focus:ring-canary/15',
                          )}
                        />
                      </label>
                    );
                  })}
                </div>
                <button type="button" className="mt-3 text-xs font-medium text-canary hover:underline" onClick={() => setSaved(false)}>
                  {t('quizShowAgain')}
                </button>
              </fieldset>
            )}
            <label className="mt-3 flex items-start gap-2.5 text-sm text-fg-muted">
              <input
                type="checkbox"
                checked={allowWallet}
                onChange={(e) => setAllowWallet(e.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-canary"
              />
              {t('allowWallet')}
            </label>
            <Callout tone="caution" className="mt-2">
              {t('allowWalletRisk')}
            </Callout>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={!saved || !quizPassed(phrase, quiz, answers) || !account || !!busy || !!createPending}
                loading={busy === 'create'}
                onClick={() => void create()}
              >
                {tv('confirmCreate')}
              </Button>
              <Button variant="ghost" disabled={!!busy} onClick={cancelMode}>
                {t('closeVault')}
              </Button>
            </div>
            {!account && <p className="mt-3 text-xs leading-5 text-fg-subtle">{tv('needWalletToCreate')}</p>}
            {createPending && (
              <Callout tone="caution" role="alert" title={t('pendingTitle', { n: 0 })} className="mt-4">
                {pendingCopy(createPending.request)}
                <p className="mt-1">{t('pendingCreateNote')}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {createPending.request.kind === 'setOwner' && (
                    <Button variant="primary" size="sm" loading={busy === 'resendCreate'} disabled={!!busy} onClick={() => void resendCreate()}>
                      {t('resend')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setCreatePending(null)}>
                    {t('closeVault')}
                  </Button>
                </div>
              </Callout>
            )}
          </div>
        )}

        {mode === 'open' && (
          <div>
            <label htmlFor="vault-phrase" className="text-sm font-medium text-fg">
              {t('phraseLabel')}
            </label>
            <textarea
              id="vault-phrase"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={t('phrasePlaceholder')}
              rows={3}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              aria-describedby="vault-phrase-count"
              className="mt-2 w-full rounded-xl border border-field bg-ink/60 px-4 py-3 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-canary focus:outline-hidden focus:ring-4 focus:ring-canary/15"
            />
            <p id="vault-phrase-count" className={cn('mt-1 font-mono text-[11px] tabular-nums', phraseValid ? 'text-emerald-300' : 'text-fg-subtle')}>
              {t('wordCount', { count: wordCount })}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="primary" loading={busy === 'open'} disabled={!!busy} onClick={() => void openExisting()}>
                {t('open')}
              </Button>
              <Button variant="ghost" disabled={!!busy} onClick={cancelMode}>
                {t('closeVault')}
              </Button>
            </div>
          </div>
        )}

        {keys && !vault && mode === 'idle' && busy !== 'create' && busy !== 'resendCreate' && (
          <div>
            <p className="text-sm leading-6 text-fg-muted">{tv('vaultNotLoaded')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button loading={busy === 'reload'} disabled={!!busy} onClick={() => void reloadVault()}>
                {t('reloadVault')}
              </Button>
              <Button variant="ghost" disabled={!!busy} onClick={closeUnread}>
                {t('closeVault')}
              </Button>
            </div>
          </div>
        )}

        {keys && vault && (
          <div className="space-y-5">
            <StatGrid className="sm:grid-cols-2">
              <Stat label={t('vaultAddress')} value={<AddressChip value={vault.address} href={explorer(VAULT_CLUSTER, `address/${vault.address}`)} />} valueClass="text-sm" />
              <Stat
                label={t('balance')}
                value={`${sol(vault.spendable)} SOL`}
                valueClass="font-mono text-2xl font-medium text-canary"
                foot={t('spendableHint', { rent: sol(vault.lamports - vault.spendable) })}
              />
              <Stat
                label={t('keysUsed')}
                value={
                  <>
                    {vault.nonce}
                    <KeyChain nonce={vault.nonce} />
                  </>
                }
                foot={t('nextKey', { n: vault.nonce })}
              />
              <Stat
                label={t('classicalOwner')}
                valueClass={cn('font-sans text-sm leading-6 font-normal', foreignOwner ? 'text-red-300' : 'text-fg')}
                value={
                  !vault.owner
                    ? t('ownerNone')
                    : canaryTripped
                      ? t('ownerClosed')
                      : foreignOwner
                        ? t('ownerForeign', { owner: short(vault.owner) })
                        : payer
                          ? t('ownerYours', { owner: short(vault.owner) })
                          : t('ownerOn', { owner: short(vault.owner) })
                }
              />
            </StatGrid>

            {foreignOwner && <Callout tone="danger">{t('foreignOwner')}</Callout>}
            {canaryTripped && vault.owner && (
              <Callout tone="danger" role="status">
                {t('trippedNotice')}
              </Callout>
            )}

            <div className="border-t border-line pt-5">
              <label htmlFor="deposit-amount" className={FIELD_LABEL}>
                {t('depositAmount')}
              </label>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <SolInput id="deposit-amount" value={depositAmount} onChange={setDepositAmount} disabled={!!busy} />
                <Button loading={busy === 'deposit'} disabled={!!busy} onClick={() => void deposit()}>
                  {t('deposit')}
                </Button>
                {airdropButton}
              </div>
            </div>

            <div className="space-y-3 border-t border-line pt-5">
              <div>
                <label htmlFor="withdraw-to" className={FIELD_LABEL}>
                  {t('destination')}
                </label>
                <input
                  id="withdraw-to"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder={t('destinationPlaceholder')}
                  aria-describedby="withdraw-to-hint"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={locked}
                  className={cn(FIELD, 'mt-2')}
                />
                <p id="withdraw-to-hint" className="mt-1.5 text-xs text-fg-subtle">
                  {t('destinationHint')}
                </p>
              </div>
              <div>
                <label htmlFor="withdraw-amount" className={FIELD_LABEL}>
                  {t('withdrawAmount')}
                </label>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <SolInput id="withdraw-amount" value={withdrawAmount} onChange={setWithdrawAmount} disabled={locked} />
                  <Button
                    variant="primary"
                    className="h-auto! w-full whitespace-normal! py-2 text-center sm:h-10! sm:w-auto sm:py-0 sm:whitespace-nowrap!"
                    loading={busy === 'withdrawPq'}
                    disabled={locked}
                    onClick={() => void withdrawPq()}
                  >
                    {t('withdrawPq')}
                  </Button>
                  {vault.owner && payer && vault.owner === payer && !canaryTripped && (
                    <Button loading={busy === 'withdrawWallet'} disabled={locked} onClick={() => void withdrawWallet()}>
                      {t('withdrawWallet')}
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-xs leading-5 text-fg-subtle">{t('pqHint', { n: vault.nonce })}</p>
              {vault.owner && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 h-auto! whitespace-normal! py-2 text-left"
                  loading={busy === 'removeWallet'} disabled={locked} onClick={() => void removeWallet()}>
                  {t('removeWallet')}
                </Button>
              )}
              <p className="text-xs leading-5 text-fg-subtle">{t('oneDevice')}</p>
            </div>

            {pending && (
              <Callout tone="caution" role="alert" title={t('pendingTitle', { n: pending.nonce })}>
                {pendingCopy(pending.request)}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="sm" loading={busy === 'resend'} disabled={!!busy} onClick={() => void resend()}>
                    {t('resend')}
                  </Button>
                  <a
                    href={explorer(VAULT_CLUSTER, `address/${vault.address}`)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-canary"
                  >
                    {t('checkVault')}
                    <ArrowUpRight className="h-3 w-3" />
                  </a>
                </div>
              </Callout>
            )}
          </div>
        )}

        <TxFeedback progress={progress} status={status} cluster={VAULT_CLUSTER} />
      </Card>
    </div>
  );
}
