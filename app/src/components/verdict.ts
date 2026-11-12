import type { Key } from '../copy';
import type { Authority, ControlRow, Multisig, ProgramControl } from '../lib/solana';
import type { Tone } from './ui';

// An Ed25519 key is quantum-exposed, not exploitable today. An authority one derived key can use (a lone key, or a
// multisig whose threshold one key meets) is red; a multisig that needs several is amber; a revoked authority holds
// no key at all.

/** Fewest distinct Ed25519 keys that meet the threshold. A key listed twice fills two slots on-chain. */
function keysNeeded({ m, signers }: Multisig): number {
  const slots = new Map<string, number>();
  for (const s of signers) if (s.kind === 'exposed') slots.set(s.address, (slots.get(s.address) ?? 0) + 1);
  let filled = 0;
  let keys = 0;
  for (const n of [...slots.values()].sort((x, y) => y - x)) {
    if (filled >= m) break;
    filled += n;
    keys++;
  }
  return keys;
}

/** A quantum-exposed authority that a single derived key can use. */
function oneKey(authority: Authority | undefined): boolean {
  return authority?.kind === 'exposed' && (!authority.multisig || keysNeeded(authority.multisig) === 1);
}

export function authorityBadge(authority: Authority | undefined): [Tone, Key] {
  if (authority === undefined) return ['muted', 'vUnknown'];
  if (authority === null) return ['good', 'authNone'];
  if (authority.multisig) return [oneKey(authority) ? 'bad' : 'warn', authority.kind === 'exposed' ? 'authMultisigExposed' : 'authMultisigPda'];
  return authority.kind === 'exposed' ? ['bad', 'authExposed'] : ['warn', 'authPda'];
}

/** Worst case among the rows that can move funds or change supply. When none of those holds a key but another row
 *  does (a metadata, staker or voter key), the header says so instead of claiming no authority is left. */
export function rowsVerdict(rows: ControlRow[]): [Tone, Key] {
  const critical = rows.filter((r) => r.critical).map((r) => r.authority);
  if (critical.some(oneKey)) return ['bad', 'vExposed'];
  if (critical.some((a) => a?.kind === 'exposed')) return ['warn', 'vExposed'];
  if (critical.some((a) => a?.kind === 'pda')) return ['warn', 'vProgramControlled'];
  if (rows.some((r) => r.authority)) return ['info', 'vNoCriticalAuthority'];
  return ['good', 'vNoAuthority'];
}

export function programVerdict(control: ProgramControl): [Tone, Key, Key] {
  if (control === undefined) return ['muted', 'vUnknown', 'upgradeUnknown'];
  if (control === 'closed') return ['muted', 'vClosed', 'programClosed'];
  if (control === 'builtin') return ['good', 'vBuiltin', 'programBuiltin'];
  if (control === null) return ['good', 'vImmutable', 'upgradeNone'];
  return control.kind === 'exposed' ? ['bad', 'vExposed', 'upgradeExposed'] : ['warn', 'vProgramControlled', 'upgradePda'];
}

/** Badge for who can upgrade a program: its authority, or its closed, built-in or unknown state. */
export function controlBadge(control: ProgramControl): [Tone, Key] {
  if (control === 'closed' || control === 'builtin') {
    const [tone, label] = programVerdict(control);
    return [tone, label];
  }
  return authorityBadge(control);
}

/** A program-owned account. Only its owner program's upgrade authority is read, so an immutable owner still only
 *  makes it program-controlled, and an owner that could not be read leaves it unknown. */
export function accountVerdict(owner: ProgramControl): [Tone, Key] {
  if (owner === undefined) return ['muted', 'vUnknown'];
  if (owner && owner !== 'closed' && owner !== 'builtin' && owner.kind === 'exposed') return ['bad', 'vExposed'];
  return ['info', 'vProgramControlled'];
}

/** The "not exploitable today" note for a result that shows quantum-exposed keys, or null if it shows none. */
export function todayNote(authorities: (Authority | undefined)[]): Key | null {
  if (authorities.some(oneKey)) return 'todayKey';
  return authorities.some((a) => a?.kind === 'exposed') ? 'todayMultisig' : null;
}
