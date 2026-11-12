import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import type { Authority, ControlRow } from '../lib/solana';
import { accountVerdict, authorityBadge, controlBadge, programVerdict, rowsVerdict, todayNote } from './verdict';

const KEY: Authority = { address: 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG' as Address, kind: 'exposed' };
const OTHER_KEY: Authority = { address: '7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar' as Address, kind: 'exposed' };
const PDA: Authority = { address: 'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ' as Address, kind: 'pda' };
const multisig = (m: number, signers: Authority[]): NonNullable<Authority> => ({
  ...KEY,
  multisig: { m, signers: signers.flatMap((s) => (s ? [{ address: s.address, kind: s.kind }] : [])) },
});
/** 2-of-4 with two Ed25519 keys: both must be derived. */
const MULTISIG = multisig(2, [KEY, OTHER_KEY, PDA, PDA]);
/** 2-of-3 listing one key twice: that key alone fills both required slots, as the token program counts them. */
const REPEATED = multisig(2, [KEY, KEY, OTHER_KEY]);
const ONE_OF_TWO = multisig(1, [KEY, OTHER_KEY]);

const row = (label: ControlRow['label'], authority: Authority, critical = true): ControlRow => ({ label, authority, critical });

describe('authorityBadge', () => {
  it('marks a lone Ed25519 key red, a multisig amber and a revoked authority as none', () => {
    expect(authorityBadge(KEY)).toEqual(['bad', 'authExposed']);
    expect(authorityBadge(MULTISIG)).toEqual(['warn', 'authMultisigExposed']);
    expect(authorityBadge({ ...MULTISIG, kind: 'pda' })).toEqual(['warn', 'authMultisigPda']);
    expect(authorityBadge(PDA)).toEqual(['warn', 'authPda']);
    expect(authorityBadge(null)).toEqual(['good', 'authNone']);
    expect(authorityBadge(undefined)).toEqual(['muted', 'vUnknown']);
  });

  it('marks a multisig red when one derived key meets its threshold', () => {
    expect(authorityBadge(ONE_OF_TWO)).toEqual(['bad', 'authMultisigExposed']);
    expect(authorityBadge(REPEATED)).toEqual(['bad', 'authMultisigExposed']);
    expect(rowsVerdict([row('rowMintAuthority', ONE_OF_TWO)])).toEqual(['bad', 'vExposed']);
    expect(todayNote([REPEATED])).toBe('todayKey');
  });
});

describe('rowsVerdict', () => {
  it('never says no authority is left while a Token-2022 mint still has a metadata key', () => {
    const mint = [
      row('rowMintAuthority', null),
      row('rowFreezeAuthority', null),
      row('rowMetadataUpdate', KEY, false),
      row('rowMetadataPointer', null, false),
    ];
    expect(rowsVerdict(mint)).toEqual(['info', 'vNoCriticalAuthority']);
    expect(rowsVerdict(mint.map((r) => ({ ...r, authority: null })))).toEqual(['good', 'vNoAuthority']);
  });

  it('is red for a lone key, amber when only multisigs or program-derived addresses hold the critical rows', () => {
    expect(rowsVerdict([row('rowMintAuthority', MULTISIG), row('rowFreezeAuthority', KEY)])).toEqual(['bad', 'vExposed']);
    expect(rowsVerdict([row('rowMintAuthority', MULTISIG), row('rowFreezeAuthority', MULTISIG)])).toEqual(['warn', 'vExposed']);
    expect(rowsVerdict([row('rowMintAuthority', PDA), row('rowFreezeAuthority', null)])).toEqual(['warn', 'vProgramControlled']);
  });
});

describe('program and program-owned account verdicts', () => {
  it('calls a program without upgrade authority code-immutable, nothing more', () => {
    expect(programVerdict(null)).toEqual(['good', 'vImmutable', 'upgradeNone']);
    expect(programVerdict(KEY)).toEqual(['bad', 'vExposed', 'upgradeExposed']);
  });

  it('does not vouch for an account whose owner program is immutable or could not be read', () => {
    expect(accountVerdict(undefined)).toEqual(['muted', 'vUnknown']);
    expect(accountVerdict(null)).toEqual(['info', 'vProgramControlled']);
    expect(accountVerdict(PDA)).toEqual(['info', 'vProgramControlled']);
    expect(accountVerdict(KEY)).toEqual(['bad', 'vExposed']);
    expect(controlBadge('closed')).toEqual(['muted', 'vClosed']);
    expect(controlBadge('builtin')).toEqual(['good', 'vBuiltin']);
    expect(controlBadge(undefined)).toEqual(['muted', 'vUnknown']);
  });
});

describe('todayNote', () => {
  it('explains what an attack would need, only when an exposed key is shown', () => {
    expect(todayNote([KEY, MULTISIG])).toBe('todayKey');
    expect(todayNote([MULTISIG, null])).toBe('todayMultisig');
    expect(todayNote([PDA, null, undefined])).toBeNull();
  });
});
