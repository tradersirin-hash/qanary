import { sha256 } from '@noble/hashes/sha2';
import { address, type Instruction } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import * as lmots from './lmots';
import {
  deriveKeys,
  pqSetOwnerIx,
  pqWithdrawSolIx,
  setOwnerMessage,
  signedByCurrentKey,
  VAULT_PROGRAM,
  withdrawSolMessage,
  type SeenInstruction,
  type VaultState,
} from './qanary';

const keys = deriveKeys(`${'abandon '.repeat(23)}art`);
const VAULT = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const DEST = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
const OWNER = address('HG9k4yEyErN3bAmtoXLMvNNmaDhcQJqEbP3PXpr9j8XX');
const Q = 3;

/** The vault as the chain shows it while key `q` is current. */
const vaultAt = (q: number): VaultState => ({
  address: VAULT,
  id: keys.id,
  genesisKey: keys.genesisKey,
  key: lmots.publicKey(keys.id, q, keys.seed),
  nonce: q,
  owner: null,
  lamports: 0n,
  spendable: 0n,
});
const nextKey = (q: number) => lmots.publicKey(keys.id, q + 1, keys.seed);
const seen = (ix: Instruction): SeenInstruction => ({
  program: ix.programAddress,
  accounts: (ix.accounts ?? []).map((a) => a.address),
  data: new Uint8Array(ix.data ?? []),
});

function withdrawIx(q: number, signedBy = q, amount = 5_000n) {
  const message = withdrawSolMessage(VAULT, q, nextKey(q), DEST, amount);
  const signature = lmots.signDeterministic(keys.id, signedBy, keys.seed, message);
  return seen(pqWithdrawSolIx(VAULT, DEST, signature, amount, nextKey(q)));
}

describe('signedByCurrentKey', () => {
  it('finds a withdrawal the current key signed and recovers the exact request', () => {
    const found = signedByCurrentKey([withdrawIx(Q)], vaultAt(Q));
    expect(found?.request).toEqual({ kind: 'withdrawSol', destination: DEST, amount: '5000' });
    expect(found?.message).toEqual(withdrawSolMessage(VAULT, Q, nextKey(Q), DEST, 5_000n));
  });

  it('finds owner changes, with and without an owner', () => {
    for (const owner of [OWNER, null]) {
      const message = setOwnerMessage(VAULT, Q, nextKey(Q), owner);
      const signature = lmots.signDeterministic(keys.id, Q, keys.seed, message);
      const found = signedByCurrentKey([seen(pqSetOwnerIx(VAULT, signature, owner, nextKey(Q)))], vaultAt(Q));
      expect(found?.request).toEqual({ kind: 'setOwner', owner });
    }
  });

  it('ignores signatures by older keys, other vaults, other programs and tampered data', () => {
    expect(signedByCurrentKey([withdrawIx(Q - 1)], vaultAt(Q)), 'older key, older message').toBeNull();
    expect(signedByCurrentKey([withdrawIx(Q, Q - 1)], vaultAt(Q)), 'signed by another key').toBeNull();

    const other = { ...withdrawIx(Q), program: 'Stake11111111111111111111111111111111111111' };
    expect(signedByCurrentKey([other], vaultAt(Q)), 'other program').toBeNull();
    const otherVault = { ...withdrawIx(Q), accounts: [DEST, DEST] };
    expect(signedByCurrentKey([otherVault], vaultAt(Q)), 'other vault').toBeNull();

    const tampered = withdrawIx(Q);
    tampered.data[tampered.data.length - lmots.N - 8] ^= 1; // the amount
    expect(signedByCurrentKey([tampered], vaultAt(Q)), 'amount changed').toBeNull();
    expect(signedByCurrentKey([{ ...withdrawIx(Q), data: withdrawIx(Q).data.slice(0, 40) }], vaultAt(Q)), 'truncated').toBeNull();
  });

  it('recognises a token withdrawal by the current key, which this app cannot re-send', () => {
    const mint = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const amount = new Uint8Array(8);
    new DataView(amount.buffer).setBigUint64(0, 42n, true);
    // The program's token message: domain | 2 | program | vault | q | next key | mint | destination | amount.
    const sol = withdrawSolMessage(VAULT, Q, nextKey(Q), DEST, 0n);
    const prefix = sol.slice(0, sol.length - 32 - 8);
    prefix['qanary-vault-v1'.length] = 2;
    const message = new Uint8Array([...prefix, ...bs58(mint), ...bs58(DEST), ...amount]);
    const signature = lmots.signDeterministic(keys.id, Q, keys.seed, message);
    const tag = sha256(new TextEncoder().encode('global:pq_withdraw_token')).slice(0, 8);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, signature.length, true);
    const data = new Uint8Array([...tag, ...len, ...signature, ...amount, ...nextKey(Q)]);
    const ata = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
    const ix: SeenInstruction = { program: VAULT_PROGRAM, accounts: [VAULT, mint, ata, DEST, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], data };
    const found = signedByCurrentKey([ix], vaultAt(Q));
    expect(found?.message).toEqual(message);
    expect(found?.request).toBeNull();
  });
});

/** Base58 decode for test addresses. */
function bs58(s: string): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(alphabet.indexOf(c));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
