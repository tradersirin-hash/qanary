// Readiness census: who can change the programs and tokens that hold value on Solana, and with which keys.
// Run from app/:  node scripts/readiness.mjs --in <inputs.json> --out <results.json>
//                 node scripts/readiness.mjs --self-test
//
// Purpose: on Solana every keypair address is its Ed25519 public key, so every authority held by a key is public
// by design. A cryptographically relevant quantum computer (none exists today, and nobody knows when or whether one
// will) could derive such a private key from the address with Shor's algorithm. This census reads, for a list of
// programs and token mints, who can upgrade each program and who can mint or freeze each token, classifies that
// authority, and totals the value behind each class: protocol TVL (taken from the inputs, never estimated here)
// for programs, and supply times the Jupiter USD price for mints.
//
// Method (read-only: JSON-RPC reads and public GET APIs, one request at a time with a small pause, retries on 429
// and 5xx, a fallback RPC, and no transaction is ever built or sent):
//   - Program: the owning loader. Upgradeable loader: the upgrade authority stored in the ProgramData account
//     (none = immutable). Loader v4: the authority in the program account, none once finalized. BPFLoader1/2:
//     immutable. NativeLoader: a builtin that only a validator release can change.
//   - Mint (SPL Token or Token-2022): supply and decimals, mint and freeze authority, and for Token-2022 every
//     extension with the authorities stored in it (permanent delegate, transfer hook, pausable, confidential
//     transfer, fees, metadata and so on). An authority that is an SPL Token multisig account is shown as m-of-n
//     with the kind of each signer, as app/src/lib/solana.ts does, wherever the token program accepts a multisig.
//   - An authority off the Ed25519 curve (a PDA) has no private key; some program signs for it. To find which,
//     the census first looks at the account's owner, then reads transactions that touched the address
//     (getSignaturesForAddress, then getTransaction with maxSupportedTransactionVersion 1, since mainnet carries
//     version 1 transactions) in up to three passes, each only while the controller is still unknown or ambiguous:
//     the latest transactions of the address; for a program's upgrade authority, the latest transactions of its
//     ProgramData account (every upgrade is signed by the authority); and the oldest transactions of the address
//     (a multisig vault is usually created and funded there). Squads v4, Squads v3, the Coral (Serum) multisig and
//     SPL Governance (Realms and its forks) are confirmed by re-deriving the PDA from a multisig or governance
//     account of the same transaction, and the multisig is decoded (threshold, members, time lock). Otherwise the
//     controller is a program above an instruction in which the address signed (see Limits).
//
// Classes (an authority gets exactly one):
//   none            no authority: unset, revoked, an immutable loader, a finalized loader-v4 program, or a burned
//                   small-order key such as the System Program id, which decodes as a curve point no key signs for
//   single_key      an on-curve Ed25519 address: one private key, whose public key is the address itself
//   spl_multisig    (mints only) an SPL Token multisig account; m of its listed signers must sign
//   squads_v4       a Squads v4 vault PDA; threshold, members, voters, time lock (seconds) and any config authority
//                   (an address that may change the members on its own) are decoded, and the config authority
//                   is classified in turn (one level)
//   squads_v3       a Squads v3 (squads-mpl) authority PDA; threshold and members are decoded (v3 has no time lock)
//   spl_governance  an SPL Governance (Realms or fork) governance account or its native treasury PDA
//   pda_other       a PDA that another program signs for; the program is named and, one level deep, its own
//                   upgrade authority is classified too. The Coral multisig lands here, with its threshold decoded,
//                   and so does an SPL stake pool's withdraw authority (the mint authority of an LST), confirmed
//                   by derivation, with the pool's manager and staker keys
//   pda_unknown     a PDA for which nothing in the examined transactions identified the controller
// Program rows can also be: builtin (NativeLoader), closed (ProgramData closed), missing (no account, or not an
// executable program), error (a read failed after retries). Mint rows that are not a mint get missing or error.
//
// "Weakest" (to count each protocol once, by its weakest program) follows this order, weakest first:
//   single_key, spl_multisig, pda_unknown, pda_other, squads_v3, squads_v4, spl_governance, builtin, none, closed.
// It is a coarse ranking: one key before several, an unidentified controller before an identified one, a multisig
// without a time lock (v3) before one that may have one (v4). Threshold and time lock are reported separately.
//
// Inputs (JSON):
//   { "protocols": [ { "name": "Kamino Lend", "slug": "kamino-lend", "tvl_usd": 1186553900,
//                      "tvl_source": "DefiLlama /protocols", "programs": ["KLend2g3...", { "id": "...", "label": "farms" }] } ],
//     "programs":  [ "<program id>" | { "id": "...", "protocol": "<slug or name>", "label": "..." } ],
//     "mints":     [ "<mint>" | { "mint": "...", "symbol": "USDC", "name": "USD Coin" } ] }
//   "tvl" is accepted for "tvl_usd". A program listed under several protocols carries each one's TVL.
//   A "programs" entry may also be a whole protocol in the shape of docs/readiness/inputs-*.json:
//     { "protocol": "Jito", "defillama_slug": "jito", "solana_tvl_usd": 927623923, "tvl_read_at": "...",
//       "own_program": true, "program_ids": [ { "id": "...", "role": "..." } ], "uses_programs": [ { "id": "...", "role": "..." } ] }
//   "uses_programs" are shared programs run by someone else that hold the protocol's funds (for example the SPL
//   stake-pool program behind an LST). They count for the protocol's weakest class like its own programs, and are
//   marked relation "uses" on the program row.
// Output: { read_at, slot, rpc, method, protocols, programs, mints, aggregates }, sorted deterministically
// (protocols by name, programs by protocol then id, mints by symbol then address). A short summary goes to stdout,
// progress to stderr.
//
// Limits:
//   - A snapshot: authorities, multisig members and thresholds can change at any time after read_at.
//   - PDA controllers are inferred from at most --max-txs successful transactions per pass (default 12, out of the
//     latest --max-sigs = 40 signatures), plus --oldest-txs (default 4) of the oldest ones when the history fits in
//     --oldest-pages (default 5) pages of 1,000 signatures. A PDA with no signing use in those windows (for example
//     one that only appears as the future authority in new mints) stays pda_unknown, with the programs it
//     appeared with. History comes from api.mainnet-beta.solana.com, because the primary RPC keeps only recent
//     history; a result built from the fallback's history carries "history_rpc" so it can be re-checked.
//   - The signer of an inner (CPI) instruction is not recorded on chain. A PDA's signature can only come from the
//     program that derives it, and it is handed down the call stack with the account, so every non-system program
//     above an instruction in which the address held a signing role (authority, mint authority, transfer source
//     and similar fields of parsed instructions) is a candidate. The candidates common to all signing uses seen
//     are kept; if several remain, the one owning the PDA's account is named, else the innermost, and the
//     candidates are listed: evidence "cpi_signer". Failing that, a PDA account owned by a program is attributed
//     to its owner: evidence "account_owner". Both are marked verified: false. Squads, Coral, Governance and
//     stake-pool withdraw-authority matches are confirmed by PDA derivation (verified: true).
//   - Classes describe who can sign today. They do not say whether a multisig's members are themselves exposed
//     keys (member kinds are listed), how a DAO votes, or whether a protocol keeps funds behind other authorities
//     (oracles, admin keys inside program state) that this census does not read.
//   - Token value = supply x Jupiter price; it is null when Jupiter has no price. TVL is whatever the inputs say,
//     and totals add protocols as listed: where one protocol's TVL already includes another's (DefiLlama lists
//     some of these overlaps), the total counts that value twice. A program's value_behind_usd adds the TVL of
//     every protocol that lists it, so a shared program can carry overlapping figures too.
//   - Builtins are changed by validator releases and feature activation, not by a key; they are listed apart.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, isOffCurveAddress } from '@solana/kit';

// ---------------------------------------------------------------------------------------------------------------
// Settings

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
function option(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}
const MAX_SIGS = Number(option('--max-sigs', '40'));
const MAX_TXS = Number(option('--max-txs', '12'));
/** When the latest transactions show no signing use, up to this many pages of 1,000 signatures are read back to
 *  the start of the address's history, and its oldest OLDEST_TXS successful transactions are examined. */
const OLDEST_PAGES = Number(option('--oldest-pages', '5'));
const OLDEST_TXS = Number(option('--oldest-txs', '4'));
/** Mainnet carries version 1 transactions (a newer message format); asking for at most version 0 makes the RPC
 *  refuse them with error -32015, so the census accepts both. */
const MAX_TX_VERSION = 1;
const DELAY_MS = Number(option('--delay-ms', '150'));
const PRIMARY_RPC = option('--rpc', 'https://solana-rpc.publicnode.com');
const FALLBACK_RPC = 'https://api.mainnet-beta.solana.com';
/** Account reads go to the primary; history goes to the public mainnet RPC first, which keeps full history. */
const ACCOUNT_RPCS = [PRIMARY_RPC, FALLBACK_RPC];
const HISTORY_RPCS = [option('--history-rpc', FALLBACK_RPC), PRIMARY_RPC].filter((u, i, all) => all.indexOf(u) === i);
const JUP = 'https://lite-api.jup.ag';
/** Jupiter's keyless API allows 5 requests per 10 seconds per IP. */
const JUP_GAP_MS = 2_200;
const HEADERS = { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0', accept: 'application/json' };
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** The census only reads. Anything else is refused before a request is made. */
const READ_METHODS = new Set(['getAccountInfo', 'getMultipleAccounts', 'getSignaturesForAddress', 'getTransaction', 'getSlot', 'getTokenSupply']);
/** JSON-RPC errors worth retrying on the same endpoint (node behind, block not yet available, internal error). */
const RETRYABLE_RPC_CODES = new Set([-32004, -32005, -32014, -32603]);

// ---------------------------------------------------------------------------------------------------------------
// Well-known addresses

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const NATIVE_LOADER = 'NativeLoader1111111111111111111111111111111';
const LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LOADER_V4 = 'LoaderV411111111111111111111111111111111111';
const LOADER_NAMES = {
  [LOADER_UPGRADEABLE]: 'upgradeable',
  [LOADER_V4]: 'loader_v4',
  BPFLoader2111111111111111111111111111111111: 'bpf_loader_2',
  BPFLoader1111111111111111111111111111111111: 'bpf_loader_1',
  [NATIVE_LOADER]: 'native',
};
const IMMUTABLE_LOADERS = new Set(['BPFLoader2111111111111111111111111111111111', 'BPFLoader1111111111111111111111111111111111']);

const SQUADS_V4 = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const SQUADS_V3 = 'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu';
/** The Coral (formerly Serum) multisig, github.com/coral-xyz/multisig, as deployed on mainnet. */
const CORAL_MULTISIG = 'msigmtwzgXJHj2ext4XJjCDmpbcMuufFb5cHuwg6Xdt';
/** SPL Governance instances: every programId in the Realms registry, public/realms/mainnet-beta.json of
 *  github.com/Mythic-Project/governance-ui (read 2026-11-07). Other forks are recognised by their
 *  "GOVERNANCE-INSTRUCTION:" log line, which spl-governance prints for every instruction. */
const GOVERNANCE_PROGRAMS = new Set([
  'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', 'Ghope52FuF6HU3AAhJuAAyS2fiqbVhkAotb7YprL5tdS',
  'GqTPL6qRf5aUuqscLh8Rg2HTxPUXfhhAXDptTLhp1t2J', 'hgovkRU6Ghe1Qoyb54HdSLdqN7VtxaifBzRmh9jtd3S',
  'gUAedF544JeE6NYbQakQvribHykUNgaPJqcgf3UQVnY', 'DcG2PZTnj8s4Pnmp7xJswniCskckU5E6XsrKuyD7NYFK',
  '4ruGZqLoPVKX27Qm91Qjsqt5AzCtLrhmjKT8ubwHiVZu', 'AEauWRrpn9Cs6GXujzdp1YhMmv2288kBt3SdEcPYEerr',
  'AVoAYTs36yB5izAaBkxRG67wL1AMwG3vo41hKtUSb8is', 'G41fmJzd29v7Qmdi8ZyTBBYa98ghh3cwHBTexqCG1PQJ',
  'GovHgfDPyQ1GwazJTDY2avSVY8GGcpmCapmmCsymRaGe', 'pytGY6tWRgGinSCvRLnSv4fHfBTMoiDGiCsesmHWM6U',
  'J9uWvULFL47gtCPvgR3oN7W357iehn5WF2Vn9MJvcSxz', 'JPGov2SBA6f7XSJF5R4Si5jEJekGiyrwP2m7gSEqLUs',
  '5hAykmD4YGcQ7Am3N7nC9kyELq6CThAkU82nhNKDJiCy', 'gSF1T5PdLc2EutzwAyeExvdW27ySDtFp88ri5Aymah6',
  'GmtpXy362L8cZfkRmTZMYunWVe8TyRjX5B7sodPZ63LJ', 'GMpXgTSJt2nJ7zjD1RwbT2QyPhKqD2MjAZuEaLsfPYLF',
  'bqTjmeob6XTdfh12px2fZq4aJMpfSY1R1nHZ44VgVZD', '5sGZEdn32y8nHax7TxEyoHuPS3UXfPWtisgm8kqxat8H',
  'smfjietFKFJ4Sbw1cqESBTpPhF4CwbMwN8kBEC1e5ui', 'GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs',
  'GCockTxUjxuMdojHiABVZ5NKp6At8eTKDiizbPjiCo4m', 'HT19EcD68zn7NoCF79b2ucQF8XaMdowyPt5ccS6g1PUx',
  'GRNPT8MPw3LYY6RdjsgKeFji5kMiG1fSxnxDjDBu4s73', 'ALLGnZikNaJQeN4KCAbDjZRSzvSefUdeTpk18yfizZvT',
  'A7kmu2kUcnQwAVn8B4znQmGJeUrsJ1WEhYVMtmiBLkEr', 'MGovW65tDhMMcpEmsegpsdgvzb6zUwGsNjhXFxRAnjd',
  'jdaoDN37BrVRvxuXSeyR7xE5Z9CAoQApexGrQJbnj6V', 'GMnke6kxYvqoAXgbFGnu84QzvNHoqqTnijWSXYYTFQbB',
  'Di9ZVJeJrRZdQEWzAFYmfjukjR5dUQb7KMaDmv34rNJg', 'jtogvBNH3WBSWDYD5FJfQP2ZxNTuf82zL8GkEhPeaJx',
  'dgov7NC8iaumWw3k8TkmLDybvZBCmd1qwxgLAGAsWxf', 'GovRp7uazvmYkQ7gqjdfjKFwr6pHDcYFWH3SP9DHzdtR',
]);
/** Runtime, token and loader programs: they execute a PDA's signature but never hold one, so they are never named
 *  as the controller of a PDA. */
const PLUMBING = new Set([
  SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, NATIVE_LOADER, LOADER_UPGRADEABLE, LOADER_V4,
  ...IMMUTABLE_LOADERS,
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
  'ComputeBudget111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'AddressLookupTab1e1111111111111111111111111', 'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111', 'Config1111111111111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111', 'KeccakSecp256k11111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111',
]);

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();
const utf8 = (s) => new TextEncoder().encode(s);
const addrAt = (bytes, offset) => addressDecoder.decode(bytes.subarray(offset, offset + 32));
const sha8 = (s) => createHash('sha256').update(s).digest().subarray(0, 8);
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Small-order Ed25519 encodings (the same list as app/src/lib/solana.ts). They decode as curve points, but no key
 *  can sign for them, so an authority set to one of them (typically the all-zero System Program id) is burned. */
const SMALL_ORDER = new Set(
  [
    '0000000000000000000000000000000000000000000000000000000000000000',
    '0100000000000000000000000000000000000000000000000000000000000000',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  ].map((hex) => addressDecoder.decode(Buffer.from(hex, 'hex'))),
);

/** 'single_key' (on the curve, so a private key exists), 'pda' (off the curve) or 'burned' (small order). */
function keyKind(a) {
  if (SMALL_ORDER.has(a)) return 'burned';
  return isOffCurveAddress(address(a)) ? 'pda' : 'single_key';
}

function isAddress(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    address(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Network: sequential, paced, retried, read-only

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = { rpc_calls: 0, retries: 0, fallbacks: 0, jupiter_calls: 0 };
let lastRpcAt = 0;
/** The endpoint that answered the latest successful call, so history read from the fallback can be flagged. */
let lastEndpoint = null;
const progress = (line) => process.stderr.write(`${line}\n`);
/** api.mainnet-beta.solana.com allows about 40 calls of one method per 10 seconds, so it gets a wider gap. */
const gapFor = (url) => (url.includes('api.mainnet-beta.solana.com') ? Math.max(DELAY_MS, 300) : DELAY_MS);

async function rpc(method, params, endpoints = ACCOUNT_RPCS) {
  if (!READ_METHODS.has(method)) throw new Error(`refusing ${method}: this census only reads`);
  let lastError;
  for (const [n, url] of endpoints.entries()) {
    if (n > 0) {
      stats.fallbacks++;
      progress(`  ${method}: falling back to ${url} after: ${lastError?.message ?? lastError}`);
    }
    for (let attempt = 0; ; attempt++) {
      const pause = lastRpcAt + gapFor(url) - Date.now();
      if (pause > 0) await sleep(pause);
      lastRpcAt = Date.now();
      stats.rpc_calls++;
      let retryAfter = 0;
      let retryable = true;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(45_000),
        });
        if (res.ok) {
          const json = await res.json();
          if (!json.error) {
            lastEndpoint = url;
            return json.result;
          }
          lastError = new Error(`${method} on ${url}: ${json.error.code} ${json.error.message}`);
          retryable = RETRYABLE_RPC_CODES.has(json.error.code);
        } else {
          lastError = new Error(`${method} on ${url}: HTTP ${res.status}`);
          retryable = res.status === 429 || res.status >= 500;
          retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0;
        }
      } catch (e) {
        lastError = e; // network error or timeout: retried
      }
      if (!retryable || attempt >= RETRY_MS.length) break;
      stats.retries++;
      await sleep(Math.max(RETRY_MS[attempt], retryAfter));
    }
  }
  throw lastError;
}

let lastJupAt = 0;
/** GET from Jupiter's keyless API, paced to its rate limit; null after retries or on a 4xx other than 429. */
async function jupiterGet(path) {
  for (let attempt = 0; ; attempt++) {
    const pause = lastJupAt + JUP_GAP_MS - Date.now();
    if (pause > 0) await sleep(pause);
    lastJupAt = Date.now();
    stats.jupiter_calls++;
    let retryAfter = 0;
    try {
      const res = await fetch(`${JUP}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) return null;
      retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0;
    } catch {
      // network error or timeout: retried
    }
    if (attempt >= RETRY_MS.length) return null;
    stats.retries++;
    await sleep(Math.max(RETRY_MS[attempt], retryAfter, JUP_GAP_MS));
  }
}

/** Promise cache, so concurrent or repeated lookups of one key share a single read. */
function memo(fn) {
  const cache = new Map();
  return (key, ...rest) => {
    if (!cache.has(key)) cache.set(key, fn(key, ...rest));
    return cache.get(key);
  };
}

const readParsed = memo(async (a) => (await rpc('getAccountInfo', [a, { encoding: 'jsonParsed' }])).value);
const readBytes = memo(async (a) => {
  const value = (await rpc('getAccountInfo', [a, { encoding: 'base64' }])).value;
  return value ? { owner: value.owner, executable: value.executable, bytes: Buffer.from(value.data[0], 'base64') } : null;
});
async function readHead(a, length) {
  const value = (await rpc('getAccountInfo', [a, { encoding: 'base64', dataSlice: { offset: 0, length } }])).value;
  return value ? { owner: value.owner, executable: value.executable, bytes: Buffer.from(value.data[0], 'base64') } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Multisig layouts

/** Squads v4 `Multisig` (Anchor), github.com/Squads-Protocol/v4, programs/squads_multisig_program/src/state/multisig.rs:
 *  discriminator 8 | create_key 32 | config_authority 32 | threshold u16 | time_lock u32 (seconds between approval
 *  and execution) | transaction_index u64 | stale_transaction_index u64 | rent_collector Option<Pubkey> (Borsh: one
 *  tag byte, then 32 bytes only when Some) | bump u8 | members Vec<{ key 32, permissions u8 mask: 1 initiate,
 *  2 vote, 4 execute }>. Vaults: PDA ["multisig", multisig, "vault", u8 index] (state/seeds.rs, sdk/multisig/src/pda.ts).
 *  config_authority = default (all zeros) means config changes also need a member vote ("autonomous" multisig). */
const SQUADS_V4_DISC = sha8('account:Multisig');
function decodeSquadsV4(d) {
  if (d.length < 99 || !sameBytes(d.subarray(0, 8), SQUADS_V4_DISC)) return null;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const configAuthority = addrAt(d, 40);
  let o = 94;
  o += d[o] === 1 ? 33 : 1; // rent_collector
  o += 1; // bump
  if (o + 4 > d.length) return null;
  const count = view.getUint32(o, true);
  o += 4;
  if (o + count * 33 > d.length) return null;
  const members = [];
  for (let i = 0; i < count; i++) members.push({ key: addrAt(d, o + 33 * i), mask: d[o + 33 * i + 32] });
  return {
    threshold: view.getUint16(72, true),
    time_lock_seconds: view.getUint32(74, true),
    members: members.length,
    voters: members.filter((m) => m.mask & 2).length,
    member_kinds: kindCounts(members.map((m) => m.key)),
    config_authority: configAuthority === SYSTEM_PROGRAM ? null : { address: configAuthority, kind: keyKind(configAuthority) },
  };
}

/** Squads v3 `Ms` (Anchor), github.com/Squads-Protocol/squads-mpl, programs/squads-mpl/src/state.rs:
 *  discriminator 8 | threshold u16 | authority_index u16 | transaction_index u32 | ms_change_index u32 | bump u8 |
 *  create_key 32 | allow_external_execute bool | keys Vec<Pubkey>. Authorities: PDA ["squad", multisig,
 *  u32 LE index, "authority"]; index 0 signs as the multisig PDA itself (src/lib.rs, execute_transaction). */
const SQUADS_V3_DISC = sha8('account:Ms');
function decodeSquadsV3(d) {
  if (d.length < 58 || !sameBytes(d.subarray(0, 8), SQUADS_V3_DISC)) return null;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const count = view.getUint32(54, true);
  if (58 + count * 32 > d.length) return null;
  const keys = Array.from({ length: count }, (_, i) => addrAt(d, 58 + 32 * i));
  return { threshold: view.getUint16(8, true), authority_index_max: view.getUint16(10, true), members: count, member_kinds: kindCounts(keys) };
}

/** Coral multisig `Multisig` (Anchor), github.com/coral-xyz/multisig, programs/multisig/src/lib.rs:
 *  discriminator 8 | owners Vec<Pubkey> | threshold u64 | nonce u8 | owner_set_seqno u32. Signer: PDA [multisig]. */
function decodeCoral(d) {
  if (d.length < 12 || !sameBytes(d.subarray(0, 8), SQUADS_V4_DISC)) return null; // same "account:Multisig" name
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const count = view.getUint32(8, true);
  const o = 12 + count * 32;
  if (o + 8 > d.length) return null;
  const owners = Array.from({ length: count }, (_, i) => addrAt(d, 12 + 32 * i));
  return { threshold: Number(view.getBigUint64(o, true)), members: count, member_kinds: kindCounts(owners) };
}

function kindCounts(keys) {
  const counts = { single_key: 0, pda: 0, burned: 0 };
  for (const k of keys) counts[keyKind(k)]++;
  return counts;
}

/** An SPL Token multisig (either token program): m of its signers sign instead of it (see solana.ts). */
async function splMultisig(a) {
  const value = await readParsed(a);
  if (!value || (value.owner !== TOKEN_PROGRAM && value.owner !== TOKEN_2022_PROGRAM)) return null;
  const data = value.data;
  if (!data || Array.isArray(data) || data.parsed?.type !== 'multisig') return null;
  const info = data.parsed.info ?? {};
  const m = Number(info.numRequiredSigners);
  const signers = (info.signers ?? []).filter(isAddress);
  if (info.isInitialized !== true || !Number.isInteger(m) || m < 1 || signers.length < m) return null;
  const kinds = signers.map((s) => ({ address: s, kind: keyKind(s) }));
  const exposed = kinds.filter((s) => s.kind === 'single_key').length;
  // keys_alone_reach_threshold: the on-curve signers alone can act, as solana.ts marks a multisig 'exposed'.
  return { type: 'spl_token', m, n: signers.length, signers: kinds, exposed_signers: exposed, keys_alone_reach_threshold: exposed >= m };
}

// ---------------------------------------------------------------------------------------------------------------
// PDA controller identification

/** Index of `target` among `count` PDAs made by `derive(i)`, or -1. Results are cached per multisig. */
const derivedLists = new Map();
async function findDerivedIndex(cacheKey, count, derive, target) {
  let list = derivedLists.get(cacheKey);
  if (!list) derivedLists.set(cacheKey, (list = []));
  for (let i = 0; i < count; i++) {
    if (list[i] === undefined) list[i] = await derive(i);
    if (list[i] === target) return i;
  }
  return -1;
}

const pdaOf = async (program, seeds) => (await getProgramDerivedAddress({ programAddress: address(program), seeds }))[0];
const u32le = (i) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, i, true);
  return b;
};

async function squadsV4Controller(multisig, target, evidence, tx) {
  const account = await readBytes(multisig);
  if (account?.owner !== SQUADS_V4) return null;
  const decoded = decodeSquadsV4(account.bytes);
  if (!decoded) return null;
  let vaultIndex = null;
  if (target !== multisig) {
    const ms = addressEncoder.encode(address(multisig));
    vaultIndex = await findDerivedIndex(`v4:${multisig}`, 256, (i) => pdaOf(SQUADS_V4, [utf8('multisig'), ms, utf8('vault'), Uint8Array.of(i)]), target);
    if (vaultIndex < 0) return null;
  }
  return { class: 'squads_v4', controller: { name: 'Squads v4', program: SQUADS_V4, multisig, vault_index: vaultIndex, ...decoded, verified: true, evidence, tx } };
}

async function squadsV3Controller(multisig, target, evidence, tx) {
  const account = await readBytes(multisig);
  if (account?.owner !== SQUADS_V3) return null;
  const decoded = decodeSquadsV3(account.bytes);
  if (!decoded) return null;
  let index = 0; // index 0 signs as the multisig PDA itself
  if (target !== multisig) {
    const ms = addressEncoder.encode(address(multisig));
    const count = Math.max(decoded.authority_index_max + 8, 32);
    index = await findDerivedIndex(`v3:${multisig}`, count, (i) => pdaOf(SQUADS_V3, [utf8('squad'), ms, u32le(i), utf8('authority')]), target);
    if (index < 0) return null;
  }
  const { authority_index_max: _, ...rest } = decoded;
  return { class: 'squads_v3', controller: { name: 'Squads v3', program: SQUADS_V3, multisig, authority_index: index, ...rest, time_lock_seconds: null, verified: true, evidence, tx } };
}

async function coralController(multisig, target, evidence, tx) {
  if ((await pdaOf(CORAL_MULTISIG, [addressEncoder.encode(address(multisig))])) !== target) return null;
  const account = await readBytes(multisig);
  const decoded = account?.owner === CORAL_MULTISIG ? decodeCoral(account.bytes) : null;
  if (!decoded) return null;
  return { class: 'pda_other', controller: { name: 'Coral multisig', program: CORAL_MULTISIG, multisig, ...decoded, time_lock_seconds: null, verified: true, evidence, tx } };
}

/** A governance account signs for itself; its SOL treasury is PDA ["native-treasury", governance]. */
async function governanceController(program, candidates, target, targetOwner, evidence, tx) {
  if (targetOwner === program) {
    return { class: 'spl_governance', controller: { name: 'SPL Governance', program, governance: target, via: 'governance_account', fork: program !== 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', verified: true, evidence, tx } };
  }
  for (const governance of candidates) {
    if (governance === target || !isAddress(governance)) continue;
    if ((await pdaOf(program, [utf8('native-treasury'), addressEncoder.encode(address(governance))])) === target) {
      return { class: 'spl_governance', controller: { name: 'SPL Governance', program, governance, via: 'native_treasury', fork: program !== 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', verified: true, evidence, tx } };
    }
  }
  return null;
}

/** SPL stake pool (and its forks, such as Sanctum's): the withdraw authority, which is also the LST's mint authority,
 *  is PDA [stake_pool, "withdraw"] of the pool program (github.com/solana-program/stake-pool, program/src/lib.rs,
 *  AUTHORITY_WITHDRAW). `StakePool` (program/src/state.rs, Borsh): account_type u8 (1 = StakePool) | manager 32 |
 *  staker 32 | stake_deposit_authority 32 | stake_withdraw_bump_seed u8 | validator_list 32 | reserve_stake 32 |
 *  pool_mint 32. The manager sets fees and the staker; the staker moves stake between validators. */
async function stakePoolController(program, accounts, target, tx) {
  for (const pool of new Set(accounts)) {
    if (pool === target || pool === program || PLUMBING.has(pool) || !isAddress(pool)) continue;
    if ((await pdaOf(program, [addressEncoder.encode(address(pool)), utf8('withdraw')])) !== target) continue;
    const account = await readBytes(pool);
    const d = account?.owner === program && account.bytes.length >= 194 && account.bytes[0] === 1 ? account.bytes : null;
    const key = (o) => ({ address: addrAt(d, o), kind: keyKind(addrAt(d, o)) });
    const decoded = d ? { manager: key(1), staker: key(33), stake_deposit_authority: key(65), pool_mint: addrAt(d, 162) } : {};
    return { class: 'pda_other', controller: { name: d ? 'Stake pool' : null, program, pool, role: 'withdraw_authority', ...decoded, verified: true, evidence: 'derived', tx } };
  }
  return null;
}

/** Fields of parsed instructions whose account must sign (loader upgrade/setAuthority, token transfer/mintTo/burn/
 *  closeAccount, system transfer/createAccount, stake withdraw...). `initialize*` instructions are skipped: there
 *  these fields name a future authority, not a signer. */
const SIGNER_FIELDS = ['authority', 'multisigAuthority', 'mintAuthority', 'multisigMintAuthority', 'freezeAuthority', 'multisigFreezeAuthority', 'withdrawAuthority', 'stakeAuthority', 'nonceAuthority', 'owner', 'multisigOwner', 'source', 'sourceBase'];

function accountsOf(ix) {
  if (Array.isArray(ix.accounts)) return ix.accounts;
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      if (isAddress(v)) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  if (ix.parsed && typeof ix.parsed === 'object') walk(ix.parsed.info);
  return out;
}

function signsIn(ix, a) {
  const parsed = ix.parsed;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string' || parsed.type.startsWith('initialize')) return false;
  const info = parsed.info ?? {};
  return SIGNER_FIELDS.some((f) => info[f] === a) || (Array.isArray(info.signers) && info.signers.includes(a));
}

/** Programs that printed "GOVERNANCE-INSTRUCTION:" (spl-governance does for every instruction), from the log stack. */
function governanceLoggers(logs) {
  const stack = [];
  const found = new Set();
  for (const line of logs ?? []) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) stack.push(invoke[1]);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else if (line.startsWith('Program log: GOVERNANCE-INSTRUCTION:') && stack.length) found.add(stack[stack.length - 1]);
  }
  return found;
}

/** Vault and authority indices tried when a multisig only appears elsewhere in the same transaction. */
const SAME_TX_INDICES = 16;

/** `a` may be a vault of a multisig that the transaction used without passing `a` to it, for example a Squads
 *  multisig created in the same transaction that then funds its vault, or a vault that hands an authority to `a`
 *  while `a` is another vault of the same or a new multisig. Every account of a Squads or governance instruction in
 *  the transaction is tried as the multisig or governance account, and a match is confirmed by derivation. */
async function sameTransactionMatch(entries, a, owner, govLoggers, signature) {
  const v4 = new Set();
  const v3 = new Set();
  const gov = new Map();
  for (const { ix } of entries) {
    const program = ix.programId;
    const accounts = accountsOf(ix).filter((x) => x !== a && !PLUMBING.has(x) && !x.startsWith('Sysvar'));
    if (program === SQUADS_V4) accounts.forEach((x) => v4.add(x));
    else if (program === SQUADS_V3) accounts.forEach((x) => v3.add(x));
    else if (GOVERNANCE_PROGRAMS.has(program) || govLoggers.has(program)) {
      if (!gov.has(program)) gov.set(program, new Set());
      accounts.forEach((x) => gov.get(program).add(x));
    }
  }
  for (const ms of v4) {
    const seed = addressEncoder.encode(address(ms));
    const i = await findDerivedIndex(`v4:${ms}`, SAME_TX_INDICES, (k) => pdaOf(SQUADS_V4, [utf8('multisig'), seed, utf8('vault'), Uint8Array.of(k)]), a);
    if (i >= 0) {
      const found = await squadsV4Controller(ms, a, 'derived', signature);
      if (found) return found;
    }
  }
  for (const ms of v3) {
    const seed = addressEncoder.encode(address(ms));
    const i = await findDerivedIndex(`v3:${ms}`, SAME_TX_INDICES, (k) => pdaOf(SQUADS_V3, [utf8('squad'), seed, u32le(k), utf8('authority')]), a);
    if (i >= 0) {
      const found = await squadsV3Controller(ms, a, 'derived', signature);
      if (found) return found;
    }
  }
  for (const [program, candidates] of gov) {
    const found = await governanceController(program, [...candidates], a, owner, 'derived', signature);
    if (found) return found;
  }
  return null;
}

/** Looks for `a` in one transaction. Returns { verified } for a derivation-confirmed Squads/Coral/Governance match;
 *  otherwise `uses`, one per instruction in which `a` held a signing role, each listing the non-system programs
 *  above that instruction (innermost first) that received `a` and so could have signed for it; and the programs
 *  `a` appeared with. */
async function inspectTransaction(tx, a, owner, signature) {
  const message = tx.transaction?.message;
  if (!message) return { seenWith: [], uses: [] };
  const inner = new Map((tx.meta?.innerInstructions ?? []).map((g) => [g.index, g.instructions]));
  const govLoggers = governanceLoggers(tx.meta?.logMessages);
  const seenWith = new Set();
  const uses = [];
  const everything = [];
  let present = false;
  for (const [index, outer] of message.instructions.entries()) {
    const entries = [{ ix: outer, height: 1 }, ...(inner.get(index) ?? []).map((ix) => ({ ix, height: ix.stackHeight ?? 2 }))];
    everything.push(...entries);
    if (!entries.some((e) => accountsOf(e.ix).includes(a))) continue;
    present = true;
    const stack = [];
    for (const { ix, height } of entries) {
      stack.length = height - 1;
      stack[height - 1] = ix;
      const accounts = accountsOf(ix);
      if (!accounts.includes(a)) continue;
      const program = ix.programId;
      if (!PLUMBING.has(program)) seenWith.add(program);
      // A known controller instruction that received `a`: confirm by derivation from its first account.
      let verified = null;
      if (program === SQUADS_V4 && accounts[0]) verified = await squadsV4Controller(accounts[0], a, 'derived', signature);
      else if (program === SQUADS_V3 && accounts[0]) verified = await squadsV3Controller(accounts[0], a, 'derived', signature);
      else if (program === CORAL_MULTISIG && accounts[0]) verified = await coralController(accounts[0], a, 'derived', signature);
      else if (GOVERNANCE_PROGRAMS.has(program) || govLoggers.has(program)) verified = await governanceController(program, accounts, a, owner, 'derived', signature);
      else if (!PLUMBING.has(program) && accounts.length <= 64) verified = await stakePoolController(program, accounts, a, signature);
      if (verified) return { verified, seenWith: [...seenWith], uses: [] };
      // `a` held a signing role here. Only a program above this instruction can have signed for it, and a signature
      // made higher up is handed down with the account, so every non-system ancestor that received `a` is a candidate.
      if (height > 1 && signsIn(ix, a)) {
        const above = stack.slice(0, height - 1).reverse().filter((p) => p && !PLUMBING.has(p.programId));
        const holding = above.filter((p) => accountsOf(p).includes(a));
        const candidates = [...new Set((holding.length ? holding : above).map((p) => p.programId))];
        if (candidates.length) uses.push(candidates);
      }
    }
  }
  if (present) {
    const sameTx = await sameTransactionMatch(everything, a, owner, govLoggers, signature);
    if (sameTx) return { verified: sameTx, seenWith: [...seenWith], uses: [] };
  }
  return { uses, seenWith: [...seenWith] };
}

/** Programs present in every signing use, in the order of the most recent use (innermost first). */
function commonCandidates(uses) {
  if (!uses.length) return [];
  return uses[0].candidates.filter((p) => uses.every((u) => u.candidates.includes(p)));
}

/** Who signs for a PDA. Cached per address; `program_upgrade` is added by classifyAuthority. `related`: accounts
 *  whose history should show `a` signing (a program's ProgramData, where every upgrade is signed by its authority).
 *  History is read in three passes, each only while the previous one left the controller unknown or ambiguous:
 *  the latest transactions of `a`, the latest transactions of the related accounts, and the oldest transactions of
 *  `a` (where a multisig vault is usually created and funded). */
const identifyPda = memo(async (a, related = []) => {
  const account = await readParsed(a);
  const owner = account?.owner ?? null;
  if (owner === SQUADS_V4) {
    const found = await squadsV4Controller(a, a, 'account_owner', null);
    if (found) return found;
  }
  if (owner === SQUADS_V3) {
    const found = await squadsV3Controller(a, a, 'account_owner', null);
    if (found) return found;
  }
  if (owner && GOVERNANCE_PROGRAMS.has(owner)) return governanceController(owner, [], a, owner, 'account_owner', null);

  const seen = new Map();
  const uses = [];
  const done = new Set();
  let examined = 0;
  let failed = 0;
  let fallbackHistory = null;
  const history = async (target, options) => {
    const list = (await rpc('getSignaturesForAddress', [target, options], HISTORY_RPCS)) ?? [];
    // History served by the fallback may be only recent: flagged so a result built from it is read with care.
    if (lastEndpoint !== HISTORY_RPCS[0]) fallbackHistory = lastEndpoint;
    return list;
  };
  const multisigUnverified = () => [SQUADS_V4, SQUADS_V3, CORAL_MULTISIG].some((p) => seen.has(p));
  const settled = () => {
    if (!uses.length || multisigUnverified()) return false;
    const common = commonCandidates(uses);
    return common.length <= 1 || common.includes(owner);
  };
  /** Reads up to `budget` successful transactions from `signatures` that were not read yet. */
  const scan = async (signatures, budget) => {
    let n = 0;
    for (const s of signatures) {
      if (n >= budget || settled()) break;
      if (s.err || done.has(s.signature)) continue;
      done.add(s.signature);
      n++;
      examined++;
      let tx;
      try {
        tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: MAX_TX_VERSION }], HISTORY_RPCS);
      } catch (e) {
        failed++;
        progress(`  getTransaction ${s.signature} skipped: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (!tx) continue;
      const result = await inspectTransaction(tx, a, owner, s.signature);
      if (result.verified) return result.verified;
      for (const p of result.seenWith) seen.set(p, (seen.get(p) ?? 0) + 1);
      for (const candidates of result.uses) uses.push({ candidates, tx: s.signature });
    }
    return null;
  };

  // Pass 1: the latest transactions of `a`.
  const latest = await history(a, { limit: MAX_SIGS });
  let found = await scan(latest, MAX_TXS);
  // Pass 2: the latest transactions of the related accounts (upgrades are signed by the upgrade authority).
  for (const r of related) {
    if (found || settled()) break;
    found = await scan(await history(r, { limit: MAX_SIGS }), MAX_TXS);
  }
  // Pass 3: the oldest transactions of `a`, when nothing above showed it signing.
  if (!found && uses.length === 0) {
    let oldest = latest;
    if (latest.length >= MAX_SIGS) {
      oldest = [];
      let before = latest[latest.length - 1].signature;
      for (let page = 0; page < OLDEST_PAGES; page++) {
        const list = await history(a, { limit: 1000, before });
        if (list.length < 1000) {
          oldest = list.length ? list : latest;
          break;
        }
        before = list[list.length - 1].signature;
      }
    }
    found = await scan([...oldest].reverse(), OLDEST_TXS);
  }
  if (found) return found;

  const shallow = fallbackHistory ? { history_rpc: fallbackHistory } : {};
  const failures = failed ? { transactions_failed: failed } : {};
  const seenWith = [...seen.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([p]) => p);
  if (uses.length) {
    // The deriving program must sit above every signing use, so the programs common to all of them are the
    // candidates. When more than one remains, the one that owns the PDA's account (a program creates the accounts
    // at its own PDAs) is named; failing that the innermost. The candidates are listed either way.
    const common = commonCandidates(uses);
    const byOwner = common.length > 1 && common.includes(owner);
    const pick = byOwner ? owner : common[0] ?? uses[0].candidates[0];
    const ambiguous = common.length > 1 ? { candidates: common, picked_by: byOwner ? 'account_owner' : 'innermost' } : common.length === 0 ? { candidates: [...new Set(uses.flatMap((u) => u.candidates))], picked_by: 'innermost' } : {};
    return { class: 'pda_other', controller: { program: pick, evidence: 'cpi_signer', tx: uses[0].tx, signing_uses: uses.length, ...ambiguous, verified: false, examined_transactions: examined, ...failures, ...shallow } };
  }
  if (owner && owner !== SYSTEM_PROGRAM && !PLUMBING.has(owner)) {
    return { class: 'pda_other', controller: { program: owner, evidence: 'account_owner', verified: false, examined_transactions: examined, ...failures, ...shallow } };
  }
  return { class: 'pda_unknown', controller: { owner, seen_with: seenWith.slice(0, 5), examined_transactions: examined, signatures_found: latest.length, ...failures, ...shallow } };
});

/** Classifies one authority value (an address string or null). `tokenMultisig`: the token program would accept an
 *  SPL Token multisig here. `depth` limits how far the controller program's own upgrade authority is followed. */
async function classifyAuthority(value, { tokenMultisig = false, depth = 0, related = [] } = {}) {
  if (value === null || value === undefined || value === '') return { address: null, class: 'none' };
  if (!isAddress(value)) return { address: String(value), class: 'error', error: 'not an address' };
  if (SMALL_ORDER.has(value)) return { address: value, class: 'none', burned: true };
  if (tokenMultisig) {
    const multisig = await splMultisig(value);
    if (multisig) return { address: value, class: 'spl_multisig', multisig };
  }
  if (keyKind(value) === 'single_key') return { address: value, class: 'single_key' };
  const found = await identifyPda(value, related);
  const result = { address: value, class: found.class, controller: { ...found.controller } };
  if (found.class === 'pda_other' && depth === 0 && result.controller.program) {
    const row = await readProgram(result.controller.program, depth + 1);
    result.controller.program_upgrade = {
      loader: row.loader,
      state: row.state,
      class: row.class,
      upgrade_authority: row.upgrade_authority?.address ?? null,
      ...(row.upgrade_authority?.controller ? { controller: row.upgrade_authority.controller } : {}),
    };
  }
  // A Squads v4 config authority can change members and threshold without a vote, so whoever signs for it is
  // classified too (one level: its own controller's settings are reported but not followed further).
  const config = result.controller.config_authority;
  if (config && depth === 0) {
    let configClass = config.kind === 'single_key' ? 'single_key' : 'none';
    let configController;
    if (config.kind === 'pda') {
      const who = await identifyPda(config.address);
      configClass = who.class;
      const c = who.controller ?? {};
      configController = Object.fromEntries(
        ['program', 'multisig', 'vault_index', 'governance', 'threshold', 'members', 'voters', 'time_lock_seconds', 'evidence', 'verified', 'owner', 'seen_with', 'examined_transactions', 'signatures_found']
          .filter((k) => c[k] !== undefined)
          .map((k) => [k, c[k]]),
      );
    }
    result.controller.config_authority = { ...config, class: configClass, ...(configController ? { controller: configController } : {}) };
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Programs

/** Program row, cached per program and depth (depth 0 rows follow a pda_other controller's own upgrade authority). */
const readProgramCached = memo((key) => {
  const [id, depth] = key.split('|');
  return readProgramUncached(id, Number(depth));
});
const readProgram = (id, depth = 0) => readProgramCached(`${id}|${depth}`);

async function readProgramUncached(id, depth) {
  const row = { program_id: id, loader: null, state: null, programdata: null, last_deploy_slot: null, upgrade_authority: null, class: null };
  try {
    const head = await readHead(id, 48);
    if (!head) return { ...row, state: 'missing', class: 'missing' };
    row.loader = LOADER_NAMES[head.owner] ?? 'other';
    if (head.owner === NATIVE_LOADER) return { ...row, state: 'builtin', class: 'builtin' };
    if (!head.executable) return { ...row, state: 'not_executable', class: 'missing', owner: head.owner };
    if (IMMUTABLE_LOADERS.has(head.owner)) return { ...row, state: 'deployed', upgrade_authority: { address: null, class: 'none' }, class: 'none' };

    if (head.owner === LOADER_UPGRADEABLE) {
      // Program account: u32 tag (2 = Program) + programdata address.
      if (head.bytes.length < 36 || head.bytes[0] !== 2) return { ...row, state: 'unreadable', class: 'error', error: 'not a Program account' };
      row.programdata = addrAt(head.bytes, 4);
      // ProgramData: u32 tag (3) + u64 deploy slot + Option<Pubkey> upgrade authority.
      const pd = await readHead(row.programdata, 45);
      if (!pd) return { ...row, state: 'closed', class: 'closed' };
      if (pd.bytes.length < 13 || pd.bytes[0] !== 3) return { ...row, state: 'unreadable', class: 'error', error: 'not a ProgramData account' };
      row.last_deploy_slot = Number(pd.bytes.readBigUInt64LE(4));
      row.state = 'deployed';
      const authority = pd.bytes[12] === 1 && pd.bytes.length >= 45 ? addrAt(pd.bytes, 13) : null;
      row.upgrade_authority = await classifyAuthority(authority, { depth, related: [row.programdata] });
      row.class = row.upgrade_authority.class;
      if (row.upgrade_authority.controller?.program === id) row.upgrade_authority.controller.self_controlled = true;
      return row;
    }

    if (head.owner === LOADER_V4) {
      // LoaderV4State: u64 slot + authority (or next version) + u64 status (0 retracted, 1 deployed, 2 finalized).
      if (head.bytes.length < 48) return { ...row, state: 'unreadable', class: 'error', error: 'short loader-v4 account' };
      row.last_deploy_slot = Number(head.bytes.readBigUInt64LE(0));
      const status = head.bytes[40];
      row.state = status === 2 ? 'finalized' : status === 0 ? 'retracted' : 'deployed';
      row.upgrade_authority = status === 2 ? { address: null, class: 'none' } : await classifyAuthority(addrAt(head.bytes, 8), { depth, related: [id] });
      row.class = row.upgrade_authority.class;
      return row;
    }
    return { ...row, state: 'unknown_loader', class: 'error', owner: head.owner, error: 'executable account of an unknown loader' };
  } catch (e) {
    return { ...row, state: 'error', class: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Mints

/** Authorities the token program checks with `validate_owner`, which accepts an SPL Token multisig; the token-metadata
 *  and token-group update authorities and the confidential-transfer authority must sign themselves (as in solana.ts). */
const NO_MULTISIG_FIELDS = new Set(['tokenMetadata.updateAuthority', 'tokenGroup.updateAuthority', 'confidentialTransferMint.authority']);
/** A few extension settings worth keeping next to their authorities. */
const EXTENSION_DETAILS = {
  transferHook: ['programId'],
  pausableConfig: ['paused'],
  defaultAccountState: ['accountState'],
  scaledUiAmountConfig: ['multiplier', 'newMultiplier', 'newMultiplierEffectiveTimestamp'],
  interestBearingConfig: ['currentRate'],
  transferFeeConfig: ['newerTransferFee'],
  confidentialTransferMint: ['autoApproveNewAccounts'],
};

async function readMint(mint) {
  const row = { mint, token_program: null, state: null, decimals: null, supply_raw: null, supply_ui: null, mint_authority: null, freeze_authority: null, extensions: [] };
  try {
    const value = await readParsed(mint);
    if (!value) return { ...row, state: 'missing', mint_authority: { address: null, class: 'missing' }, freeze_authority: { address: null, class: 'missing' } };
    const data = value.data;
    const isToken = value.owner === TOKEN_PROGRAM || value.owner === TOKEN_2022_PROGRAM;
    if (!isToken || !data || Array.isArray(data) || data.parsed?.type !== 'mint') {
      return { ...row, state: 'not_mint', owner: value.owner, mint_authority: { address: null, class: 'missing' }, freeze_authority: { address: null, class: 'missing' } };
    }
    const info = data.parsed.info;
    row.token_program = value.owner === TOKEN_PROGRAM ? 'spl_token' : 'token_2022';
    row.state = 'initialized';
    row.decimals = info.decimals;
    row.supply_raw = info.supply;
    row.mint_authority = await classifyAuthority(info.mintAuthority, { tokenMultisig: true });
    row.freeze_authority = await classifyAuthority(info.freezeAuthority, { tokenMultisig: true });

    for (const ext of info.extensions ?? []) {
      const entry = { name: ext.extension, authorities: [] };
      const state = ext.state && typeof ext.state === 'object' ? ext.state : {};
      for (const field of Object.keys(state).sort()) {
        const v = state[field];
        if (!(/authority$/i.test(field) || field === 'delegate')) continue;
        if (v === null) {
          entry.authorities.push({ field, address: null, class: 'none' });
          continue;
        }
        if (!isAddress(v)) continue; // ElGamal keys and other non-address values
        const tokenMultisig = !NO_MULTISIG_FIELDS.has(`${ext.extension}.${field}`);
        entry.authorities.push({ field, ...(await classifyAuthority(v, { tokenMultisig })) });
      }
      const details = Object.fromEntries((EXTENSION_DETAILS[ext.extension] ?? []).filter((k) => k in state).map((k) => [k, state[k]]));
      if (Object.keys(details).length) entry.details = details;
      if (ext.extension === 'tokenMetadata') row.metadata = { symbol: state.symbol ?? null, name: state.name ?? null };
      row.extensions.push(entry);
    }

    // Scaled and interest-bearing tokens: the RPC's UI supply applies the multiplier or accrued interest.
    const scaled = (info.extensions ?? []).some((e) => e.extension === 'scaledUiAmountConfig' || e.extension === 'interestBearingConfig');
    if (scaled) {
      // publicnode refuses getTokenSupply (HTTP 403), so this one starts on the public mainnet RPC.
      const supply = (await rpc('getTokenSupply', [mint], HISTORY_RPCS)).value;
      row.supply_ui = Number(supply.uiAmountString);
    } else {
      row.supply_ui = Number(BigInt(info.supply)) / 10 ** info.decimals;
    }
    return row;
  } catch (e) {
    return { ...row, state: 'error', error: e instanceof Error ? e.message : String(e), mint_authority: row.mint_authority ?? { address: null, class: 'error' }, freeze_authority: row.freeze_authority ?? { address: null, class: 'error' } };
  }
}

/** USD prices from Jupiter price v3, 50 mints per request; mints without a price are left out. */
async function fetchPrices(mints) {
  const prices = {};
  let failed = false;
  for (let i = 0; i < mints.length; i += 50) {
    const batch = mints.slice(i, i + 50);
    const json = await jupiterGet(`/price/v3?ids=${batch.join(',')}`);
    if (!json) {
      failed = true;
      continue;
    }
    for (const m of batch) if (typeof json[m]?.usdPrice === 'number') prices[m] = json[m].usdPrice;
  }
  return { prices, failed };
}

/** Symbols and names from Jupiter token search, 100 mints per request. */
async function fetchSymbols(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 100) {
    const list = await jupiterGet(`/tokens/v2/search?query=${mints.slice(i, i + 100).join(',')}`);
    for (const t of Array.isArray(list) ? list : []) {
      if (typeof t?.id === 'string' && typeof t.symbol === 'string') out[t.id] = { symbol: t.symbol, name: typeof t.name === 'string' ? t.name : null, verified: t.isVerified === true };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs, aggregates, summary

const CLASS_ORDER = ['single_key', 'spl_multisig', 'pda_unknown', 'pda_other', 'squads_v3', 'squads_v4', 'spl_governance', 'builtin', 'none', 'closed'];
const UNRESOLVED = ['missing', 'error'];
const ALL_CLASSES = [...CLASS_ORDER, ...UNRESOLVED];

/** A protocol entry in either input shape: { name, slug, tvl_usd, programs } or the census list's { protocol,
 *  defillama_slug, solana_tvl_usd, tvl_read_at, own_program, program_ids, uses_programs }. */
const isProtocolEntry = (e) => Boolean(e) && typeof e === 'object' && (Array.isArray(e.program_ids) || Array.isArray(e.uses_programs) || (Array.isArray(e.programs) && !e.id));

function loadInputs(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const protocols = new Map();
  const programs = new Map();
  const problems = [];
  const protocolKey = (p) => String(p.slug ?? p.defillama_slug ?? p.name ?? p.protocol ?? '').trim();
  const addProtocol = (p) => {
    const key = protocolKey(p);
    if (!key) return problems.push(`protocol without name or slug: ${JSON.stringify(p).slice(0, 80)}`), null;
    if (!protocols.has(key)) {
      const tvl = p.tvl_usd ?? p.tvl ?? p.solana_tvl_usd;
      const slug = p.slug ?? p.defillama_slug ?? null;
      const source = p.tvl_source ?? (p.tvl_read_at ? `${p.defillama_slug ? `DefiLlama ${p.defillama_slug}, Solana TVL, ` : ''}read ${p.tvl_read_at}` : null);
      protocols.set(key, {
        name: String(p.name ?? p.protocol ?? key),
        slug,
        tvl_usd: typeof tvl === 'number' && Number.isFinite(tvl) ? tvl : null,
        tvl_source: source,
        own_program: typeof p.own_program === 'boolean' ? p.own_program : null,
        programs: new Map(), // program id -> 'own' | 'uses'
      });
    }
    return key;
  };
  /** relation: 'own' (the protocol's own program) or 'uses' (a shared program run by someone else that holds the
   *  protocol's funds, such as a stake-pool program). Both count for the protocol's weakest class. */
  const addProgram = (entry, protocol, relation = 'own') => {
    const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.program_id ?? entry?.address;
    if (!isAddress(id)) return problems.push(`not a program address: ${JSON.stringify(entry).slice(0, 80)}`);
    const row = programs.get(id) ?? { label: null, labelRelation: null, protocols: new Map() };
    const label = typeof entry === 'object' ? entry.label ?? entry.role : null;
    // A label written by the program's own protocol is preferred to one written by a protocol that only uses it.
    if (label && (!row.label || (row.labelRelation === 'uses' && relation === 'own'))) {
      row.label = String(label);
      row.labelRelation = relation;
    }
    if (protocol) {
      if (row.protocols.get(protocol) !== 'own') row.protocols.set(protocol, relation);
      const links = protocols.get(protocol).programs;
      if (links.get(id) !== 'own') links.set(id, relation);
    }
    programs.set(id, row);
  };
  const addProtocolEntry = (p) => {
    const key = addProtocol(p);
    if (!key) return;
    for (const prog of p.programs ?? []) addProgram(prog, key, 'own');
    for (const prog of p.program_ids ?? []) addProgram(prog, key, 'own');
    for (const prog of p.uses_programs ?? []) addProgram(prog, key, 'uses');
  };
  for (const p of raw.protocols ?? []) addProtocolEntry(p);
  for (const prog of raw.programs ?? []) {
    if (isProtocolEntry(prog)) {
      addProtocolEntry(prog);
      continue;
    }
    const ref = typeof prog === 'object' ? prog.protocol : null;
    let key = null;
    if (ref) key = [...protocols.keys()].find((k) => k === ref || protocols.get(k).name === ref) ?? addProtocol({ name: ref });
    addProgram(prog, key, 'own');
  }
  const mints = new Map();
  for (const m of raw.mints ?? []) {
    const id = typeof m === 'string' ? m : m?.mint ?? m?.address ?? m?.id;
    if (!isAddress(id)) {
      problems.push(`not a mint address: ${JSON.stringify(m).slice(0, 80)}`);
      continue;
    }
    if (!mints.has(id)) mints.set(id, { symbol: typeof m === 'object' && m.symbol ? String(m.symbol) : null, name: typeof m === 'object' && m.name ? String(m.name) : null });
  }
  return { protocols, programs, mints, problems };
}

const zeroes = () => Object.fromEntries(ALL_CLASSES.map((c) => [c, 0]));
const weakest = (classes) => {
  const resolved = classes.filter((c) => CLASS_ORDER.includes(c));
  if (resolved.length === 0) return 'unresolved';
  return resolved.sort((x, y) => CLASS_ORDER.indexOf(x) - CLASS_ORDER.indexOf(y))[0];
};
const round2 = (x) => Math.round(x * 100) / 100;

/** Every classified authority in the results, nested program-upgrade authorities included. */
function* authoritiesIn(programs, mints) {
  for (const p of programs) if (p.upgrade_authority) yield p.upgrade_authority;
  for (const m of mints) {
    if (m.mint_authority) yield m.mint_authority;
    if (m.freeze_authority) yield m.freeze_authority;
    for (const e of m.extensions ?? []) yield* e.authorities;
  }
}

function aggregate(protocolRows, programs, mints) {
  const byProgram = zeroes();
  for (const p of programs) byProgram[p.class] = (byProgram[p.class] ?? 0) + 1;

  const byProtocol = { ...zeroes(), unresolved: 0 };
  const tvlByClass = { ...zeroes(), unresolved: 0 };
  let tvlTotal = 0;
  let withoutTvl = 0;
  for (const p of protocolRows) {
    byProtocol[p.weakest_class]++;
    if (p.tvl_usd === null) withoutTvl++;
    else {
      tvlByClass[p.weakest_class] += p.tvl_usd;
      tvlTotal += p.tvl_usd;
    }
  }

  const mintBy = zeroes();
  const freezeBy = zeroes();
  const mintValue = zeroes();
  const freezeValue = zeroes();
  let valueTotal = 0;
  let unpriced = 0;
  for (const m of mints) {
    const mc = m.mint_authority?.class ?? 'error';
    const fc = m.freeze_authority?.class ?? 'error';
    mintBy[mc]++;
    freezeBy[fc]++;
    if (m.value_usd === null && m.state === 'initialized') unpriced++;
    else {
      mintValue[mc] += m.value_usd;
      freezeValue[fc] += m.value_usd;
      valueTotal += m.value_usd;
    }
  }

  // Distinct multisigs anywhere in the results, including program upgrade authorities found one level deep.
  const multisigs = { squads_v4: new Map(), squads_v3: new Map(), coral: new Map(), spl_token: new Map() };
  const visit = (auth) => {
    if (!auth) return;
    const c = auth.controller;
    if (auth.multisig?.type === 'spl_token') multisigs.spl_token.set(auth.address, { m: auth.multisig.m, n: auth.multisig.n });
    if (c?.multisig && c.verified) {
      const bucket = c.program === SQUADS_V4 ? 'squads_v4' : c.program === SQUADS_V3 ? 'squads_v3' : c.program === CORAL_MULTISIG ? 'coral' : null;
      const n = bucket === 'squads_v4' ? c.voters : c.members;
      // The same multisig can appear at the top level (config authority classified) and one level deep (not).
      const earlier = bucket ? multisigs[bucket].get(c.multisig) : null;
      const config = earlier?.config_authority?.class ? earlier.config_authority : c.config_authority ?? null;
      if (bucket) multisigs[bucket].set(c.multisig, { m: c.threshold, n, time_lock_seconds: c.time_lock_seconds, config_authority: config });
    }
    if (c?.program_upgrade?.controller) visit({ controller: c.program_upgrade.controller });
  };
  for (const auth of authoritiesIn(programs, mints)) visit(auth);
  const thresholds = (map) => {
    const counts = new Map();
    for (const { m, n } of map.values()) counts.set(`${m}-of-${n}`, (counts.get(`${m}-of-${n}`) ?? 0) + 1);
    return Object.fromEntries([...counts.entries()].sort((x, y) => {
      const [xm, xn] = x[0].split('-of-').map(Number);
      const [ym, yn] = y[0].split('-of-').map(Number);
      return xm - ym || xn - yn;
    }));
  };
  const v4 = [...multisigs.squads_v4.values()];
  const timeLocks = new Map();
  for (const s of v4) timeLocks.set(s.time_lock_seconds, (timeLocks.get(s.time_lock_seconds) ?? 0) + 1);

  const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(v)]));
  return {
    programs: {
      count: programs.length,
      by_class: byProgram,
      without_protocol: programs.filter((p) => p.protocols.length === 0).length,
    },
    protocols: {
      count: protocolRows.length,
      by_weakest_class: byProtocol,
      tvl_usd_by_weakest_class: roundAll(tvlByClass),
      tvl_usd_total: round2(tvlTotal),
      without_tvl: withoutTvl,
    },
    mints: {
      count: mints.length,
      mint_authority_by_class: mintBy,
      freeze_authority_by_class: freezeBy,
      value_usd_by_mint_authority_class: roundAll(mintValue),
      value_usd_by_freeze_authority_class: roundAll(freezeValue),
      value_usd_total: round2(valueTotal),
      unpriced,
    },
    multisigs: {
      squads_v4: {
        count: v4.length,
        no_time_lock: v4.filter((s) => s.time_lock_seconds === 0).length,
        with_config_authority: v4.filter((s) => s.config_authority).length,
        config_authority_by_class: v4.filter((s) => s.config_authority).reduce((o, s) => {
          const c = s.config_authority.class ?? s.config_authority.kind;
          return { ...o, [c]: (o[c] ?? 0) + 1 };
        }, {}),
        time_lock_seconds: Object.fromEntries([...timeLocks.entries()].sort((x, y) => x[0] - y[0])),
        // "m-of-n": n counts members with the Vote permission, the ones the threshold applies to.
        thresholds_of_voters: thresholds(multisigs.squads_v4),
      },
      squads_v3: { count: multisigs.squads_v3.size, thresholds: thresholds(multisigs.squads_v3) },
      squads_without_time_lock: v4.filter((s) => s.time_lock_seconds === 0).length + multisigs.squads_v3.size,
      coral: { count: multisigs.coral.size, thresholds: thresholds(multisigs.coral) },
      spl_token: { count: multisigs.spl_token.size, thresholds: thresholds(multisigs.spl_token) },
    },
  };
}

function usd(x) {
  if (x === null || x === undefined) return 'n/a';
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;
  return `$${x.toFixed(0)}`;
}

function summary(out) {
  const a = out.aggregates;
  const classes = (counts, values) =>
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([c, n]) => (values ? `${c} ${n} (${usd(values[c])})` : `${c} ${n}`))
      .join(', ') || 'none';
  const v4 = a.multisigs.squads_v4;
  return [
    `Readiness census, read ${out.read_at} at slot ${out.slot}.`,
    `Programs: ${a.programs.count} (${classes(a.programs.by_class)}).`,
    `Protocols by weakest program: ${classes(a.protocols.by_weakest_class, a.protocols.tvl_usd_by_weakest_class)}; TVL total ${usd(a.protocols.tvl_usd_total)}, ${a.protocols.without_tvl} without TVL.`,
    `Mints: ${a.mints.count}, value ${usd(a.mints.value_usd_total)} (${a.mints.unpriced} unpriced).`,
    `  Mint authority: ${classes(a.mints.mint_authority_by_class, a.mints.value_usd_by_mint_authority_class)}.`,
    `  Freeze authority: ${classes(a.mints.freeze_authority_by_class, a.mints.value_usd_by_freeze_authority_class)}.`,
    `Squads v4 multisigs: ${v4.count}, ${v4.no_time_lock} without a time lock, thresholds (of voters) ${JSON.stringify(v4.thresholds_of_voters)}; Squads v3: ${a.multisigs.squads_v3.count} (no time lock in v3); Coral: ${a.multisigs.coral.count}; SPL Token multisigs: ${a.multisigs.spl_token.count}.`,
    `RPC: ${out.rpc.calls} calls, ${out.rpc.retries} retries, ${out.rpc.fallbacks} fallbacks; Jupiter: ${out.rpc.jupiter_calls} calls.`,
  ].join('\n');
}

/** Deterministic order: by name (case-insensitive, missing names last), then by address. */
function byNameThenId(nameX, nameY, idX, idY) {
  if (nameX !== nameY) {
    if (nameX === null || nameX === undefined) return 1;
    if (nameY === null || nameY === undefined) return -1;
    const c = nameX.localeCompare(nameY, 'en');
    if (c !== 0) return c;
  }
  return idX < idY ? -1 : idX > idY ? 1 : 0;
}

async function census(inPath, outPath) {
  const inputs = loadInputs(inPath);
  for (const p of inputs.problems) progress(`skipped input: ${p}`);
  const readAt = new Date().toISOString();
  const slot = await rpc('getSlot', [{ commitment: 'finalized' }]);

  const sortedProtocols = [...inputs.protocols.entries()].sort((x, y) => x[1].name.localeCompare(y[1].name, 'en') || (x[0] < y[0] ? -1 : 1));
  const protocolName = (key) => inputs.protocols.get(key).name;
  const firstProtocol = (id) => [...inputs.programs.get(id).protocols.keys()].map(protocolName).sort((x, y) => x.localeCompare(y, 'en'))[0] ?? null;
  const programIds = [...inputs.programs.keys()].sort((x, y) => byNameThenId(firstProtocol(x), firstProtocol(y), x, y));

  const programs = [];
  for (const [i, id] of programIds.entries()) {
    const meta = inputs.programs.get(id);
    const row = await readProgram(id, 0);
    const protos = [...meta.protocols.entries()]
      .map(([k, relation]) => ({ name: protocolName(k), slug: inputs.protocols.get(k).slug, tvl_usd: inputs.protocols.get(k).tvl_usd, relation }))
      .sort((x, y) => x.name.localeCompare(y.name, 'en'));
    const tvls = protos.map((p) => p.tvl_usd).filter((t) => t !== null);
    const { program_id: _, ...rest } = row;
    programs.push({ program_id: id, label: meta.label, protocols: protos, value_behind_usd: tvls.length ? tvls.reduce((s, t) => s + t, 0) : null, ...rest });
    const c = row.upgrade_authority?.controller;
    progress(`[program ${i + 1}/${programIds.length}] ${id} ${row.class}${c ? ` (${c.name ?? c.program ?? 'controller unknown'})` : ''}`);
  }

  const mintIds = [...inputs.mints.keys()];
  const mintRows = [];
  for (const [i, mint] of mintIds.entries()) {
    const row = await readMint(mint);
    mintRows.push(row);
    progress(`[mint ${i + 1}/${mintIds.length}] ${mint} mint=${row.mint_authority?.class} freeze=${row.freeze_authority?.class}`);
  }
  const live = mintRows.filter((m) => m.state === 'initialized').map((m) => m.mint);
  const { prices, failed: pricesFailed } = flag('--no-prices') ? { prices: {}, failed: false } : await fetchPrices(live);
  const needSymbols = mintRows.filter((m) => !inputs.mints.get(m.mint).symbol && !m.metadata?.symbol && m.state === 'initialized').map((m) => m.mint);
  const symbols = needSymbols.length && !flag('--no-prices') ? await fetchSymbols(needSymbols) : {};
  const mints = mintRows
    .map((m) => {
      const given = inputs.mints.get(m.mint);
      const symbol = given.symbol ?? m.metadata?.symbol ?? symbols[m.mint]?.symbol ?? null;
      const name = given.name ?? m.metadata?.name ?? symbols[m.mint]?.name ?? null;
      const price = prices[m.mint] ?? null;
      const { metadata: _, ...rest } = m;
      return { mint: m.mint, symbol, name, ...rest, price_usd: price, value_usd: price !== null && m.supply_ui !== null ? round2(m.supply_ui * price) : null };
    })
    .sort((x, y) => byNameThenId(x.symbol, y.symbol, x.mint, y.mint));

  const classOf = new Map(programs.map((p) => [p.program_id, p.class]));
  const protocolRows = sortedProtocols.map(([, p]) => {
    const ids = [...p.programs.keys()].sort();
    const weakestClass = weakest(ids.map((id) => classOf.get(id)));
    return {
      name: p.name,
      slug: p.slug,
      tvl_usd: p.tvl_usd,
      tvl_source: p.tvl_source,
      own_program: p.own_program,
      programs: ids,
      uses_programs: ids.filter((id) => p.programs.get(id) === 'uses'),
      weakest_class: weakestClass,
      weakest_programs: ids.filter((id) => classOf.get(id) === weakestClass),
    };
  });

  const out = {
    read_at: readAt,
    slot,
    rpc: { accounts: ACCOUNT_RPCS[0], history: HISTORY_RPCS[0], fallback: FALLBACK_RPC, calls: stats.rpc_calls, retries: stats.retries, fallbacks: stats.fallbacks, jupiter_calls: stats.jupiter_calls, prices_failed: pricesFailed },
    method: { max_signatures: MAX_SIGS, max_transactions: MAX_TXS, class_order_weakest_first: CLASS_ORDER, prices: `${JUP}/price/v3` },
    protocols: protocolRows,
    programs,
    mints,
    aggregates: aggregate(protocolRows, programs, mints),
  };
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(summary(out));
  console.log(`Wrote ${outPath}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test against live mainnet. Expected values were confirmed by hand with raw JSON-RPC on 2026-11-07
// (slot ~466.33M): account owners and ProgramData bytes, jsonParsed mints, multisig accounts decoded separately in
// Python, and PDA derivations. Multisig settings can change later; a failure then means "re-check", not "broken".

const get = (o, path) => path.split('.').reduce((v, k) => (v === null || v === undefined ? v : v[k]), o);

const SELF_TESTS = [
  { name: 'curve: USDC mint address is an Ed25519 point (keypair address)', run: async () => ({ kind: keyKind('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') }), expect: { kind: 'single_key' } },
  { name: 'curve: SPL Token ProgramData address is off the curve (PDA)', run: async () => ({ kind: keyKind('3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2') }), expect: { kind: 'pda' } },
  { name: 'curve: Squads v4 vault of Kamino Lend is off the curve (PDA)', run: async () => ({ kind: keyKind('GzFgdRJXmawPhGeBsyRCDLx4jAKPsvbUqoqitzppkzkW') }), expect: { kind: 'pda' } },
  { name: 'curve: System Program id is a burned small-order key', run: () => classifyAuthority(SYSTEM_PROGRAM), expect: { class: 'none', burned: true } },
  {
    name: 'program: SPL Token (now on the upgradeable loader, no upgrade authority)',
    run: () => readProgram(TOKEN_PROGRAM, 0),
    expect: { loader: 'upgradeable', state: 'deployed', programdata: '3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2', 'upgrade_authority.address': null, class: 'none' },
  },
  {
    name: 'program: Associated Token Account (immutable BPFLoader2)',
    run: () => readProgram('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 0),
    expect: { loader: 'bpf_loader_2', class: 'none' },
  },
  {
    name: 'mint: USDC mint and freeze authorities are 2-of-4 SPL Token multisigs of single keys',
    run: () => readMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    expect: {
      token_program: 'spl_token', decimals: 6,
      'mint_authority.address': 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG', 'mint_authority.class': 'spl_multisig',
      'mint_authority.multisig.m': 2, 'mint_authority.multisig.n': 4, 'mint_authority.multisig.exposed_signers': 4,
      'freeze_authority.address': '7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar', 'freeze_authority.class': 'spl_multisig',
      'freeze_authority.multisig.m': 2, 'freeze_authority.multisig.n': 4,
    },
  },
  {
    name: 'program: Kamino Lend upgrade authority is vault 0 of a Squads v4 multisig (5 of 10, 24 h time lock)',
    run: () => readProgram('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', 0),
    expect: {
      class: 'squads_v4', 'upgrade_authority.address': 'GzFgdRJXmawPhGeBsyRCDLx4jAKPsvbUqoqitzppkzkW',
      'upgrade_authority.controller.multisig': '6hhBGCtmg7tPWUSgp3LG6X2rsmYWAc4tNsA6G4CnfQbM', 'upgrade_authority.controller.vault_index': 0,
      'upgrade_authority.controller.threshold': 5, 'upgrade_authority.controller.members': 10, 'upgrade_authority.controller.time_lock_seconds': 86400,
      'upgrade_authority.controller.verified': true,
    },
  },
  {
    name: 'program: Token-2022 upgrade authority is authority 1 of a Squads v3 multisig (4 of 6)',
    run: () => readProgram(TOKEN_2022_PROGRAM, 0),
    expect: {
      class: 'squads_v3', 'upgrade_authority.address': 'AeLmXCbPaQHGWRLr2saFsEVfmMNuKnxRAbWCT9P5twgz',
      'upgrade_authority.controller.multisig': 'BnD53519LK7QM4ERBGvLedZDe1VoTPgtiBkGPWAACiMZ', 'upgrade_authority.controller.authority_index': 1,
      'upgrade_authority.controller.threshold': 4, 'upgrade_authority.controller.members': 6,
    },
  },
  {
    name: 'program: SPL Governance upgrade authority is the native treasury of a governance (fork found by its logs)',
    run: () => readProgram('GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', 0),
    expect: {
      class: 'spl_governance', 'upgrade_authority.address': 'HF7gCq7BMB6cFfhharTGGm31sqDdpmvLTgF4WEoW8y9n',
      'upgrade_authority.controller.program': 'GoVERLMGbGF8kwAwhyNgF1BQ2uyQPawHCWbnFRmLZCf',
      'upgrade_authority.controller.governance': '6rFUnQik5dhUsxJaxN2dKGJRD3cX8kQM3cyLD1kbaoCF', 'upgrade_authority.controller.via': 'native_treasury',
    },
  },
  {
    name: 'program: Marinade upgrade authority is the signer PDA of a Coral multisig (6 of 13)',
    run: () => readProgram('MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD', 0),
    expect: {
      class: 'pda_other', 'upgrade_authority.address': '551FBXSXdhcRDDkdcb3ThDRg84Mwe5Zs6YjJ1EEoyzBp',
      'upgrade_authority.controller.program': CORAL_MULTISIG, 'upgrade_authority.controller.multisig': 'magrsHFQxkkioAy45VWnZnFBBdKVdy2ZiRoRGYT9Wed',
      'upgrade_authority.controller.threshold': 6, 'upgrade_authority.controller.members': 13,
    },
  },
  {
    name: 'mint: JitoSOL mint authority is the stake pool withdraw-authority PDA [pool, "withdraw"] of the stake pool program',
    run: () => readMint('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'),
    expect: {
      'mint_authority.address': '6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS', 'mint_authority.class': 'pda_other',
      'mint_authority.controller.program': 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy', 'freeze_authority.class': 'none',
      'mint_authority.controller.pool': 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb', 'mint_authority.controller.verified': true,
      'mint_authority.controller.pool_mint': 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    },
  },
  // The cases below failed before the second pass, same-transaction derivation, common candidates and version 1
  // transactions were added; each was confirmed by hand from the transactions named.
  {
    name: 'program: Jito Vault upgrade authority is a Jito DAO native treasury, found in its ProgramData history (upgrade tx 2i5aXy...)',
    run: () => readProgram('Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8', 0),
    expect: {
      class: 'spl_governance', 'upgrade_authority.address': '5eosrve6LktMZgVNszYzebgmmC7BjLK8NoWyRQtcmGTF',
      'upgrade_authority.controller.program': 'jtogvBNH3WBSWDYD5FJfQP2ZxNTuf82zL8GkEhPeaJx', 'upgrade_authority.controller.via': 'native_treasury',
    },
  },
  {
    name: 'program: Jupiter Lend (second deployment) authority is vault 0 of a multisig created in the same transaction (3NanBJ...)',
    run: () => readProgram('jup6QF1sNDGpkkcu6F4qaFHcRBmnSS1VgyB4uFbBvNS', 0),
    expect: {
      class: 'squads_v4', 'upgrade_authority.address': 'A4CcB3kdi3w4fJgAim4sdN8DvadZnN4R4PPbECQqz6j7',
      'upgrade_authority.controller.multisig': '5rD6j4PWHJLdCuiR8Nc5eyRcuRNS5ZyCBXqTmWV36xHg', 'upgrade_authority.controller.vault_index': 0,
    },
  },
  {
    name: 'program: CCIP Router authority is signed for by the program at the top of every signing use (ExecuteBatch), not the program it called',
    run: () => readProgram('Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C', 0),
    expect: {
      class: 'pda_other', 'upgrade_authority.address': 'GoFoFfEDgALWRTw5dSY3VZQSwbFpvBEhDv1sFAWzYpbf',
      'upgrade_authority.controller.program': 'DoajfR5tK24xVw51fWcawUZWhAXD8yrBJVacc13neVQA',
    },
  },
  {
    name: 'mint: USDe mint authority history includes version 1 transactions and resolves to its OFT program',
    run: () => readMint('DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT'),
    expect: {
      state: 'initialized', 'mint_authority.address': '4x3oQtX4MhjTKGBeXDZbtTSLZ9cUWo5waN2UChAuthtS', 'mint_authority.class': 'pda_other',
      'mint_authority.controller.program': '9S6fwN8gZsr3ikUH38QWPDbLzyJTYcQd5GtrEWzoS2y9',
    },
  },
];

async function selfTest() {
  let failures = 0;
  for (const t of SELF_TESTS) {
    let result;
    try {
      result = await t.run();
    } catch (e) {
      failures++;
      console.log(`FAIL ${t.name}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const wrong = Object.entries(t.expect).filter(([path, want]) => get(result, path) !== want);
    if (wrong.length) failures++;
    const detail = wrong.length
      ? wrong.map(([path, want]) => `${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(get(result, path))}`).join('; ')
      : Object.entries(t.expect).map(([path, want]) => `${path}=${JSON.stringify(want)}`).join(', ');
    console.log(`${wrong.length ? 'FAIL' : 'PASS'} ${t.name}\n     ${detail}`);
  }
  console.log(`${SELF_TESTS.length - failures}/${SELF_TESTS.length} passed (${stats.rpc_calls} RPC calls, ${stats.retries} retries, ${stats.fallbacks} fallbacks).`);
  if (failures) process.exitCode = 1;
}

if (flag('--self-test')) {
  await selfTest();
} else {
  const inPath = option('--in', null);
  const outPath = option('--out', null);
  if (!inPath || !outPath) {
    console.error('usage: node scripts/readiness.mjs --in <inputs.json> --out <results.json> [--max-sigs 40] [--max-txs 12] [--oldest-pages 5] [--oldest-txs 4] [--delay-ms 150] [--rpc <url>] [--history-rpc <url>] [--no-prices]\n       node scripts/readiness.mjs --self-test');
    process.exitCode = 2;
  } else {
    await census(inPath, outPath);
  }
}
