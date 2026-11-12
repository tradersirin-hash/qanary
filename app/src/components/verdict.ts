import type { Key } from '../copy';
import type { Authority, ControlRow, ProgramControl } from '../lib/solana';
import type { Tone } from './ui';

// An Ed25519 key is quantum-exposed, not exploitable today. A lone key is one break away (red); a multisig needs
// several (amber); a revoked authority holds no key at all.

export function authorityBadge(authority: Authority | undefined): [Tone, Key] {
  if (authority === undefined) return ['muted', 'vUnknown'];
  if (authority === null) return ['good', 'authNone'];
  if (authority.multisig) return ['warn', authority.kind === 'exposed' ? 'authMultisigExposed' : 'authMultisigPda'];
  return authority.kind === 'exposed' ? ['bad', 'authExposed'] : ['warn', 'authPda'];
}

/** Worst case among the rows that can move funds or change supply. When none of those holds a key but another row
 *  does (a metadata, staker or voter key), the header says so instead of claiming no authority is left. */
export function rowsVerdict(rows: ControlRow[]): [Tone, Key] {
  const critical = rows.filter((r) => r.critical).map((r) => r.authority);
  const exposed = critical.filter((a) => a?.kind === 'exposed');
  if (exposed.some((a) => !a?.multisig)) return ['bad', 'vExposed'];
  if (exposed.length > 0) return ['warn', 'vExposed'];
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
  const exposed = authorities.filter((a) => a?.kind === 'exposed');
  if (exposed.some((a) => !a?.multisig)) return 'todayKey';
  return exposed.length > 0 ? 'todayMultisig' : null;
}
