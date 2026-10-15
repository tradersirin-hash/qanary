import { address, createSolanaRpc, getAddressDecoder, isOffCurveAddress, type Address } from '@solana/kit';
import type { Key } from '../copy';
import { MAINNET_PUBLIC_RPC } from './cluster';
import { SHOWN_TOKENS } from './constants';
import { fetchHoldings, fetchSolPrice, fetchSymbols, fetchUsdPrices, type Holdings } from './jupiter';

// api.mainnet-beta.solana.com answers 403 to browser requests (any Origin header), so default to a CORS-friendly
// public RPC. That one refuses indexed calls (getTokenAccountsByOwner), so token balances come from Jupiter
// unless a keyed RPC is configured.
const CUSTOM_RPC = import.meta.env.VITE_SOLANA_RPC;
const rpc = createSolanaRpc(CUSTOM_RPC || MAINNET_PUBLIC_RPC);
const addressDecoder = getAddressDecoder();

const SYSTEM_PROGRAM: string = '11111111111111111111111111111111';
const TOKEN_PROGRAM: string = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM: string = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const STAKE_PROGRAM: string = 'Stake11111111111111111111111111111111111111';
const VOTE_PROGRAM: string = 'Vote111111111111111111111111111111111111111';
const NATIVE_LOADER: string = 'NativeLoader1111111111111111111111111111111';
const LOADER_UPGRADEABLE: string = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LOADER_V4: string = 'LoaderV411111111111111111111111111111111111';
const LOADERS_IMMUTABLE = new Set<string>([
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
]);
const NONCE_ACCOUNT_SPACE = 80n;

/** Small-order Ed25519 encodings. They decode as curve points, but no key can sign for them,
 *  so an authority set to one of them (typically the all-zero System Program id) is burned. */
const SMALL_ORDER = new Set<string>(
  [
    '0000000000000000000000000000000000000000000000000000000000000000',
    '0100000000000000000000000000000000000000000000000000000000000000',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  ].map((hex) => addressDecoder.decode(Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16))))),
);

/** 'exposed': an Ed25519 point, so a private key exists and the address reveals its public key.
 *  'pda': off the curve, so no private key exists; a program controls it. */
export type KeyKind = 'exposed' | 'pda';
/** An SPL Token multisig: any `m` of its signers can act for it; its own address signs nothing. */
export type Multisig = { m: number; signers: { address: Address; kind: KeyKind }[] };
/** null means "no authority" (revoked, unset or burned). For a multisig, `kind` is 'exposed' when
 *  at least `m` of its signers are Ed25519 keys. */
export type Authority = { address: Address; kind: KeyKind; multisig?: Multisig } | null;
/** Who can change a program: an authority, null (immutable), closed, built-in, or undefined (unknown). */
export type ProgramControl = Authority | 'closed' | 'builtin' | undefined;

export type ControlRow = { label: Key; authority: Authority; critical: boolean };

export type TokenHolding = {
  mint: Address;
  amount: bigint;
  uiAmount: number;
  symbol?: string;
  name?: string;
  /** False when Jupiter does not verify the mint: symbols like "NVDA" are often spam copies. */
  verified?: boolean;
  usd?: number;
};

export type SolanaReport =
  | {
      kind: 'wallet';
      address: Address;
      key: KeyKind;
      sol: number;
      solUsd?: number;
      tokens: TokenHolding[];
      tokensAvailable: boolean;
      totalUsd?: number;
      pricesPartial: boolean;
    }
  | { kind: 'program'; address: Address; control: ProgramControl }
  | { kind: 'controlled'; title: Key; body: Key; address: Address; rows: ControlRow[]; sol?: number; scanTarget?: Address }
  | { kind: 'account'; address: Address; owner: Address; ownerControl: ProgramControl };

export function keyKind(a: Address): KeyKind {
  return isOffCurveAddress(a) ? 'pda' : 'exposed';
}

function authorityOf(value: unknown): Authority {
  if (typeof value !== 'string' || !value) return null;
  const a = address(value);
  if (SMALL_ORDER.has(a)) return null;
  return { address: a, kind: keyKind(a) };
}

function multisigOf(info: Record<string, unknown>): Multisig | null {
  const m = Number(info.numRequiredSigners);
  const signers = (info.signers as unknown[] | undefined) ?? [];
  if (info.isInitialized !== true || !Number.isInteger(m) || m < 1 || signers.length < m) return null;
  const resolved = signers.filter((s): s is string => typeof s === 'string').map((s) => ({ address: address(s), kind: keyKind(address(s)) }));
  return { m, signers: resolved };
}

function multisigAuthority(a: Address, multisig: Multisig): Authority {
  const exposed = multisig.signers.filter((s) => s.kind === 'exposed').length;
  return { address: a, kind: exposed >= multisig.m ? 'exposed' : 'pda', multisig };
}

/** Rows whose authority the token program checks with `validate_owner`, which accepts a multisig.
 *  The token-metadata update authority, and the confidential-transfer authority for UpdateMint and
 *  ApproveAccount, must sign themselves, so they are left as is. */
const NO_MULTISIG_ROWS = new Set<Key>(['rowMetadataUpdate', 'rowConfidential']);

/** SPL Token and Token-2022, as deployed on mainnet, accept a multisig account owned by either token program
 *  wherever they call `validate_owner`: then m of its signers sign instead and the multisig's own signature is
 *  ignored. Show those signers rather than the multisig's own key. */
async function resolveMultisigs(rows: ControlRow[]): Promise<ControlRow[]> {
  const candidates = [...new Set(rows.flatMap((r) => (r.authority && !NO_MULTISIG_ROWS.has(r.label) ? [r.authority.address] : [])))];
  if (candidates.length === 0) return rows;
  // A failed lookup would silently fall back to the wrong single-key label, so retry once and then let the
  // error reach the usual "try again" message.
  const fetchAccounts = () => rpc.getMultipleAccounts(candidates, { encoding: 'jsonParsed' }).send();
  const { value } = await fetchAccounts().catch(fetchAccounts);
  const found = new Map<string, Multisig>();
  value.forEach((account, i) => {
    const data = account?.data as { parsed?: { type?: string; info?: Record<string, unknown> } } | unknown[] | undefined;
    const tokenOwned = account?.owner === TOKEN_PROGRAM || account?.owner === TOKEN_2022_PROGRAM;
    if (!tokenOwned || !data || Array.isArray(data) || data.parsed?.type !== 'multisig') return;
    const multisig = multisigOf(data.parsed.info ?? {});
    if (multisig) found.set(candidates[i], multisig);
  });
  return rows.map((r) => {
    const multisig = r.authority && !NO_MULTISIG_ROWS.has(r.label) ? found.get(r.authority.address) : undefined;
    return multisig && r.authority ? { ...r, authority: multisigAuthority(r.authority.address, multisig) } : r;
  });
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Account header plus the first `length` bytes of its data. */
async function readHead(a: Address, length: number) {
  const { value } = await rpc.getAccountInfo(a, { encoding: 'base64', dataSlice: { offset: 0, length } }).send();
  if (!value) return null;
  return {
    owner: value.owner as string,
    executable: value.executable,
    lamports: value.lamports as bigint,
    space: value.space,
    bytes: base64Bytes(value.data[0]),
  };
}

type Parsed = { program: string; type: string; info: Record<string, unknown> };

async function readParsed(a: Address): Promise<Parsed | null> {
  const { value } = await rpc.getAccountInfo(a, { encoding: 'jsonParsed' }).send();
  const data = value?.data as { program: string; parsed: { type: string; info?: Record<string, unknown> } } | unknown[] | undefined;
  if (!data || Array.isArray(data)) return null;
  return { program: data.program, type: data.parsed.type, info: data.parsed.info ?? {} };
}

/** Upgrade authority stored in a ProgramData account: u32 tag (3) + u64 slot + Option<Pubkey>. */
function programDataAuthority(bytes: Uint8Array): Authority | undefined {
  if (bytes.length < 13 || bytes[0] !== 3) return undefined;
  if (bytes[12] !== 1) return null;
  return bytes.length < 45 ? undefined : authorityOf(addressDecoder.decode(bytes.slice(13, 45)));
}

async function programControl(program: Address, loader: string): Promise<ProgramControl> {
  if (loader === NATIVE_LOADER) return 'builtin';
  if (LOADERS_IMMUTABLE.has(loader)) return null;

  if (loader === LOADER_UPGRADEABLE) {
    // Program account: u32 tag (2 = Program) + programdata address.
    const head = await readHead(program, 36);
    if (!head || head.bytes.length < 36 || head.bytes[0] !== 2) return undefined;
    const pd = await readHead(addressDecoder.decode(head.bytes.slice(4, 36)), 45);
    if (!pd) return 'closed';
    return programDataAuthority(pd.bytes);
  }

  if (loader === LOADER_V4) {
    // LoaderV4State: u64 slot + authority (or next version) + u64 status (2 = Finalized).
    const head = await readHead(program, 48);
    if (!head || head.bytes.length < 48) return undefined;
    if (head.bytes[40] === 2) return null;
    return authorityOf(addressDecoder.decode(head.bytes.slice(8, 40)));
  }

  return undefined;
}

/** Token balances straight from a keyed RPC; the fallback when Jupiter is unreachable. */
async function rpcHoldings(a: Address): Promise<Holdings['tokens'] | null> {
  try {
    const responses = await Promise.all(
      [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) =>
        rpc.getTokenAccountsByOwner(a, { programId: address(programId) }, { encoding: 'jsonParsed' }).send(),
      ),
    );
    const byMint = new Map<string, Holdings['tokens'][number]>();
    for (const { value } of responses) {
      for (const { account } of value) {
        const info = account.data.parsed.info;
        const raw = BigInt(info.tokenAmount.amount);
        if (raw === 0n) continue;
        const prev = byMint.get(info.mint);
        if (prev) {
          prev.amount += raw;
          prev.uiAmount += Number(info.tokenAmount.uiAmountString);
        } else {
          byMint.set(info.mint, { mint: info.mint, amount: raw, uiAmount: Number(info.tokenAmount.uiAmountString) });
        }
      }
    }
    return [...byMint.values()];
  } catch {
    return null;
  }
}

async function scanWallet(a: Address, lamports: bigint): Promise<SolanaReport> {
  const held = (await fetchHoldings(a))?.tokens ?? (CUSTOM_RPC ? await rpcHoldings(a) : null);
  const tokens: TokenHolding[] = (held ?? []).map((h) => ({ mint: address(h.mint), amount: h.amount, uiAmount: h.uiAmount }));

  // SOL is priced on its own so a failed token batch can never drop it from the total.
  const [solPrice, { prices, partial }] = await Promise.all([fetchSolPrice(), fetchUsdPrices(tokens.map((t) => t.mint as string))]);
  const sol = Number(lamports) / 1e9;
  const solUsd = solPrice !== undefined ? sol * solPrice : undefined;
  for (const t of tokens) {
    const price = prices[t.mint];
    if (price !== undefined) t.usd = t.uiAmount * price;
  }
  tokens.sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1) || y.uiAmount - x.uiAmount);

  const symbols = await fetchSymbols(tokens.slice(0, SHOWN_TOKENS).map((t) => t.mint as string));
  for (const t of tokens.slice(0, SHOWN_TOKENS)) {
    const s = symbols[t.mint];
    if (s) {
      t.symbol = s.symbol;
      t.name = s.name;
      t.verified = s.verified;
    }
  }

  const tokenUsd = tokens.reduce((sum, t) => sum + (t.usd ?? 0), 0);
  const anyPriced = solUsd !== undefined || tokens.some((t) => t.usd !== undefined);
  // Without a SOL price a USD headline would silently leave the SOL out, so show the SOL amount instead.
  const totalUsd = !anyPriced || (solUsd === undefined && sol > 0) ? undefined : (solUsd ?? 0) + tokenUsd;
  const pricesPartial = partial || tokens.some((t) => t.usd === undefined);

  return { kind: 'wallet', address: a, key: keyKind(a), sol, solUsd, tokens, tokensAvailable: held !== null, totalUsd, pricesPartial };
}

const MINT_EXTENSION_ROWS: { extension: string; field: string; label: Key; critical: boolean }[] = [
  { extension: 'permanentDelegate', field: 'delegate', label: 'rowPermanentDelegate', critical: true },
  { extension: 'pausableConfig', field: 'authority', label: 'rowPause', critical: true },
  { extension: 'transferHook', field: 'authority', label: 'rowTransferHook', critical: true },
  { extension: 'mintCloseAuthority', field: 'closeAuthority', label: 'rowCloseMint', critical: true },
  { extension: 'transferFeeConfig', field: 'transferFeeConfigAuthority', label: 'rowFeeConfig', critical: true },
  { extension: 'transferFeeConfig', field: 'withdrawWithheldAuthority', label: 'rowFeeWithdraw', critical: true },
  { extension: 'confidentialTransferMint', field: 'authority', label: 'rowConfidential', critical: true },
  { extension: 'scaledUiAmountConfig', field: 'authority', label: 'rowScaledUi', critical: true },
  { extension: 'interestBearingConfig', field: 'rateAuthority', label: 'rowInterest', critical: false },
  { extension: 'tokenMetadata', field: 'updateAuthority', label: 'rowMetadataUpdate', critical: false },
  { extension: 'metadataPointer', field: 'authority', label: 'rowMetadataPointer', critical: false },
];

function mintRows(info: Record<string, unknown>): ControlRow[] {
  const rows: ControlRow[] = [
    { label: 'rowMintAuthority', authority: authorityOf(info.mintAuthority), critical: true },
    { label: 'rowFreezeAuthority', authority: authorityOf(info.freezeAuthority), critical: true },
  ];
  const extensions = (info.extensions as { extension: string; state?: Record<string, unknown> }[] | undefined) ?? [];
  for (const spec of MINT_EXTENSION_ROWS) {
    const ext = extensions.find((e) => e.extension === spec.extension);
    if (ext) rows.push({ label: spec.label, authority: authorityOf(ext.state?.[spec.field]), critical: spec.critical });
  }
  return rows;
}

function tokenAccountRows(info: Record<string, unknown>): ControlRow[] {
  const rows: ControlRow[] = [{ label: 'rowOwner', authority: authorityOf(info.owner), critical: true }];
  if (info.delegate) rows.push({ label: 'rowDelegate', authority: authorityOf(info.delegate), critical: true });
  if (info.isNative && info.closeAuthority) rows.push({ label: 'rowCloseAuthority', authority: authorityOf(info.closeAuthority), critical: true });
  return rows;
}

function stakeRows(info: Record<string, unknown>): ControlRow[] {
  const meta = info.meta as { authorized?: { staker?: string; withdrawer?: string }; lockup?: { unixTimestamp?: number; custodian?: string } } | undefined;
  const rows: ControlRow[] = [
    { label: 'rowWithdrawer', authority: authorityOf(meta?.authorized?.withdrawer), critical: true },
    { label: 'rowStaker', authority: authorityOf(meta?.authorized?.staker), critical: false },
  ];
  const lockedUntil = meta?.lockup?.unixTimestamp ?? 0;
  if (lockedUntil * 1000 > Date.now()) rows.push({ label: 'rowCustodian', authority: authorityOf(meta?.lockup?.custodian), critical: false });
  return rows;
}

function voteRows(info: Record<string, unknown>): ControlRow[] {
  const voters = (info.authorizedVoters as { authorizedVoter?: string }[] | undefined) ?? [];
  return [
    { label: 'rowWithdrawer', authority: authorityOf(info.authorizedWithdrawer), critical: true },
    { label: 'rowVoter', authority: authorityOf(voters[0]?.authorizedVoter), critical: false },
  ];
}

export async function scanSolana(input: string): Promise<SolanaReport> {
  const a = address(input);
  const head = await readHead(a, 45);
  const sol = head ? Number(head.lamports) / 1e9 : 0;

  // Durable nonce accounts are system-owned but only their stored authority can move the SOL.
  if (head && head.owner === SYSTEM_PROGRAM && head.space === NONCE_ACCOUNT_SPACE) {
    const parsed = await readParsed(a);
    if (parsed?.program === 'nonce' && parsed.type === 'initialized') {
      return {
        kind: 'controlled', title: 'nonceTitle', body: 'nonceBody', address: a, sol,
        rows: [{ label: 'rowNonceAuthority', authority: authorityOf(parsed.info.authority), critical: true }],
      };
    }
  }

  // Wallets: system-owned or not yet created. PDAs that hold SOL (e.g. multisig vaults) land here too.
  if (!head || head.owner === SYSTEM_PROGRAM) return scanWallet(a, head?.lamports ?? 0n);

  if (head.executable) return { kind: 'program', address: a, control: await programControl(a, head.owner) };

  if (head.owner === LOADER_UPGRADEABLE) {
    if (head.bytes[0] === 3) {
      return {
        kind: 'controlled', title: 'programDataTitle', body: 'programDataBody', address: a,
        rows: [{ label: 'rowUpgradeAuthority', authority: programDataAuthority(head.bytes) ?? null, critical: true }],
      };
    }
    if (head.bytes[0] === 1 && head.bytes.length >= 37) {
      // Buffer: u32 tag (1) + Option<Pubkey> authority.
      const authority = head.bytes[4] === 1 ? authorityOf(addressDecoder.decode(head.bytes.slice(5, 37))) : null;
      return {
        kind: 'controlled', title: 'bufferTitle', body: 'bufferBody', address: a,
        rows: [{ label: 'rowBufferAuthority', authority, critical: true }],
      };
    }
  }

  if (head.owner === TOKEN_PROGRAM || head.owner === TOKEN_2022_PROGRAM) {
    const parsed = await readParsed(a);
    if (parsed?.type === 'mint') {
      return { kind: 'controlled', title: 'mintTitle', body: 'mintBody', address: a, rows: await resolveMultisigs(mintRows(parsed.info)) };
    }
    if (parsed?.type === 'account') {
      return {
        kind: 'controlled', title: 'tokenAccountTitle', body: 'tokenAccountBody', address: a,
        rows: await resolveMultisigs(tokenAccountRows(parsed.info)), scanTarget: address(parsed.info.owner as string),
      };
    }
    const multisig = parsed?.type === 'multisig' ? multisigOf(parsed.info) : null;
    if (multisig) {
      return {
        kind: 'controlled', title: 'multisigTitle', body: 'multisigBody', address: a,
        rows: [{ label: 'rowSigners', authority: multisigAuthority(a, multisig), critical: true }],
      };
    }
  }

  if (head.owner === STAKE_PROGRAM || head.owner === VOTE_PROGRAM) {
    const parsed = await readParsed(a);
    if (parsed && head.owner === STAKE_PROGRAM && (parsed.type === 'initialized' || parsed.type === 'delegated')) {
      return { kind: 'controlled', title: 'stakeTitle', body: 'stakeBody', address: a, sol, rows: stakeRows(parsed.info) };
    }
    if (parsed && head.owner === VOTE_PROGRAM && parsed.type === 'vote') {
      return { kind: 'controlled', title: 'voteTitle', body: 'voteBody', address: a, sol, rows: voteRows(parsed.info) };
    }
  }

  // Any other program-owned account: its safety is its owner program's upgrade authority.
  const owner = address(head.owner);
  const ownerHead = await readHead(owner, 0);
  return { kind: 'account', address: a, owner, ownerControl: ownerHead ? await programControl(owner, ownerHead.owner) : undefined };
}
