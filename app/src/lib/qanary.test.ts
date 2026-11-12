import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import pq from '../../../onchain/programs/qanary_vault/src/instructions/pq.rs?raw';
import { deriveKeys, isValidPhrase, parseSol, RESERVED_KEYS, setOwnerMessage, toHex, withdrawSolMessage, withdrawTokenMessage } from './qanary';

describe('RESERVED_KEYS', () => {
  it('matches the vault program list (which a Rust test checks against agave)', () => {
    const block = pq.slice(pq.indexOf('pub const RESERVED_KEYS'), pq.indexOf('];', pq.indexOf('pub const RESERVED_KEYS')));
    const program = [...block.matchAll(/pubkey!\("(\w+)"\)/g)].map((m) => m[1]);
    expect(program).toHaveLength(31);
    expect([...RESERVED_KEYS].sort()).toEqual(program.sort());
  });
});

describe('signed messages match the program', () => {
  // The inputs of test_client_vectors.rs, which asserts the same bytes against Action::message: key #5 of id [7; 16]
  // and seed [42; 24], handing over to key #6.
  const vault = address('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
  const next = Uint8Array.from('e443517fba9c6628699e582ff0f5e6969d51446cf20f5cc2'.match(/../g)!, (h) => parseInt(h, 16));
  const destination = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const mint = address('So11111111111111111111111111111111111111112');

  it('builds the SOL withdrawal message the program verifies', () => {
    // CLIENT_MESSAGE in test_client_vectors.rs.
    expect(toHex(withdrawSolMessage(vault, 5, next, destination, 123_456_789n))).toBe(
      '71616e6172792d7661756c742d763101be38fa85ccca8879d436ecffc947dd20309520c22a342f651da7ad153d89993048c01b5059005455d9dcb0c6bcecdcb4fb5b2eabc1a9a82b57392baaa40f04e600000005e443517fba9c6628699e582ff0f5e6969d51446cf20f5cc2c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6115cd5b0700000000',
    );
  });

  it('builds the token withdrawal message the program verifies', () => {
    expect(toHex(withdrawTokenMessage(vault, 5, next, mint, destination, 987_654_321n))).toBe(
      '71616e6172792d7661756c742d763102be38fa85ccca8879d436ecffc947dd20309520c22a342f651da7ad153d89993048c01b5059005455d9dcb0c6bcecdcb4fb5b2eabc1a9a82b57392baaa40f04e600000005e443517fba9c6628699e582ff0f5e6969d51446cf20f5cc2069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61b168de3a00000000',
    );
  });

  it('builds the owner change messages the program verifies, with and without an owner', () => {
    expect(toHex(setOwnerMessage(vault, 5, next, destination))).toBe(
      '71616e6172792d7661756c742d763103be38fa85ccca8879d436ecffc947dd20309520c22a342f651da7ad153d89993048c01b5059005455d9dcb0c6bcecdcb4fb5b2eabc1a9a82b57392baaa40f04e600000005e443517fba9c6628699e582ff0f5e6969d51446cf20f5cc201c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61',
    );
    expect(toHex(setOwnerMessage(vault, 5, next, null))).toBe(
      '71616e6172792d7661756c742d763103be38fa85ccca8879d436ecffc947dd20309520c22a342f651da7ad153d89993048c01b5059005455d9dcb0c6bcecdcb4fb5b2eabc1a9a82b57392baaa40f04e600000005e443517fba9c6628699e582ff0f5e6969d51446cf20f5cc200',
    );
  });
});

// BIP-39 test phrase (all zero entropy, 24 words). Never use it for real funds.
const PHRASE = `${'abandon '.repeat(23)}art`;

describe('deriveKeys', () => {
  it('keeps the devnet derivation byte for byte, so existing devnet vaults still open', () => {
    // Recorded from the derivation shipped before keys became per-cluster.
    for (const k of [deriveKeys(PHRASE), deriveKeys(PHRASE, 'devnet')]) {
      expect(toHex(k.id)).toBe('5407a0206f654a7af9995781cee1cb86');
      expect(toHex(k.seed)).toBe('6311bb9869ccab9a03b6988be2458c9cd0ae1b7038080273');
      expect(toHex(k.genesisKey)).toBe('b50f180531463e5d41d50e0eca0c736f534b19f909d40571');
    }
  });

  it('gives mainnet its own id, seed and keys, so a phrase never reuses a one-time key across clusters', () => {
    const devnet = deriveKeys(PHRASE, 'devnet');
    const mainnet = deriveKeys(PHRASE, 'mainnet');
    expect(toHex(mainnet.id)).not.toBe(toHex(devnet.id));
    expect(toHex(mainnet.seed)).not.toBe(toHex(devnet.seed));
    expect(toHex(mainnet.genesisKey)).not.toBe(toHex(devnet.genesisKey));
    expect(mainnet.id).toHaveLength(16);
    expect(mainnet.seed).toHaveLength(24);
  });

  it('ignores case and extra spaces in the phrase', () => {
    const messy = `  ${PHRASE.toUpperCase().split(' ').join('   ')}  `;
    expect(isValidPhrase(messy)).toBe(true);
    expect(toHex(deriveKeys(messy).id)).toBe(toHex(deriveKeys(PHRASE).id));
  });
});

describe('parseSol', () => {
  it('parses exact decimal SOL into lamports', () => {
    expect(parseSol('1')).toBe(1_000_000_000n);
    expect(parseSol('0.1')).toBe(100_000_000n);
    expect(parseSol(' 2.000000001 ')).toBe(2_000_000_001n);
    // A decimal comma and a missing leading digit, as phone keyboards type them.
    for (const half of ['.5', '0,5', ',5']) expect(parseSol(half), half).toBe(500_000_000n);
    expect(parseSol('1,5')).toBe(1_500_000_000n);
  });

  it('rejects anything that is not a plain positive amount', () => {
    for (const bad of ['', '0', '0,0', '1.', '1.0000000001', '-1', '1e9', '1,000', '1,000.5', '1.2.3', 'abc', '18446744073.709551616']) {
      expect(parseSol(bad), bad).toBeNull();
    }
  });
});
