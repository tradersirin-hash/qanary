// LM-OTS one-time signatures (RFC 8554), parameter set LMOTS_SHA256_N24_W8 (NIST SP 800-208).
// Mirrors onchain/programs/qanary_vault/src/lmots.rs byte for byte; signing happens only here, in the browser.
import { sha256 } from '@noble/hashes/sha2';

export const N = 24;
export const P = 26;
export const ID_LEN = 16;
export const LMOTS_TYPE = 0x00000008;
export const SIG_LEN = 4 + N * (P + 1);

const D_PBLC = Uint8Array.of(0x80, 0x80);
const D_MESG = Uint8Array.of(0x81, 0x81);
const MAX_DIGIT = 255;

const u32be = (v: number) => Uint8Array.of(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const u16be = (v: number) => Uint8Array.of((v >>> 8) & 0xff, v & 0xff);

function h(...parts: Uint8Array[]): Uint8Array {
  const hasher = sha256.create();
  for (const p of parts) hasher.update(p);
  return hasher.digest().slice(0, N);
}

function digits(q: Uint8Array): Uint8Array {
  const d = new Uint8Array(P);
  d.set(q);
  let sum = 0;
  for (const b of q) sum += MAX_DIGIT - b;
  d.set(u16be(sum), N);
  return d;
}

function messageHash(id: Uint8Array, q: number, c: Uint8Array, message: Uint8Array): Uint8Array {
  return h(id, u32be(q), D_MESG, c, message);
}

function chain(id: Uint8Array, q: number, i: number, from: number, to: number, start: Uint8Array): Uint8Array {
  const buf = new Uint8Array(ID_LEN + 4 + 2 + 1 + N);
  buf.set(id, 0);
  buf.set(u32be(q), ID_LEN);
  buf.set(u16be(i), ID_LEN + 4);
  let tmp = start;
  for (let j = from; j < to; j++) {
    buf[ID_LEN + 6] = j;
    buf.set(tmp, ID_LEN + 7);
    tmp = h(buf);
  }
  return tmp;
}

/** RFC 8554 Appendix A: x_q[i] = H(I || u32str(q) || u16str(i) || u8str(0xff) || SEED). */
function secret(id: Uint8Array, q: number, i: number, seed: Uint8Array): Uint8Array {
  return h(id, u32be(q), u16be(i), Uint8Array.of(0xff), seed);
}

/** Public key K of one-time key number q. */
export function publicKey(id: Uint8Array, q: number, seed: Uint8Array): Uint8Array {
  const ends: Uint8Array[] = [];
  for (let i = 0; i < P; i++) ends.push(chain(id, q, i, 0, MAX_DIGIT, secret(id, q, i, seed)));
  return h(id, u32be(q), D_PBLC, ...ends);
}

export function sign(id: Uint8Array, q: number, seed: Uint8Array, message: Uint8Array, c: Uint8Array): Uint8Array {
  const a = digits(messageHash(id, q, c, message));
  const sig = new Uint8Array(SIG_LEN);
  sig.set(u32be(LMOTS_TYPE), 0);
  sig.set(c, 4);
  for (let i = 0; i < P; i++) sig.set(chain(id, q, i, 0, a[i], secret(id, q, i, seed)), 4 + N * (i + 1));
  return sig;
}

/** Hash steps the on-chain verifier will run for randomizer c (drives its compute cost). */
export function verifyWork(id: Uint8Array, q: number, message: Uint8Array, c: Uint8Array): number {
  return digits(messageHash(id, q, c, message)).reduce((sum, d) => sum + (MAX_DIGIT - d), 0);
}

const C_DOMAIN = new TextEncoder().encode('qanary/lmots-c/v1');

/**
 * Signs with the cheapest of `tries` randomizers derived from the secret seed and the message.
 * Deterministic on purpose: the same request always yields the byte-identical signature, on any
 * device, so a retry can never become a second signature under the same one-time key. The pick
 * keeps the on-chain verifier well under Solana's compute limit and does not weaken LM-OTS, since
 * each candidate is a pseudorandom value an attacker cannot predict without the seed.
 */
export function signDeterministic(id: Uint8Array, q: number, seed: Uint8Array, message: Uint8Array, tries = 64): Uint8Array {
  let best: Uint8Array | null = null;
  let bestWork = Infinity;
  for (let k = 0; k < tries; k++) {
    const c = h(C_DOMAIN, seed, id, u32be(q), Uint8Array.of(k), message);
    const work = verifyWork(id, q, message, c);
    if (work < bestWork) {
      best = c;
      bestWork = work;
    }
  }
  return sign(id, q, seed, message, best!);
}

export function candidatePublicKey(id: Uint8Array, q: number, message: Uint8Array, signature: Uint8Array): Uint8Array | null {
  if (signature.length !== SIG_LEN) return null;
  const type = (signature[0] << 24) | (signature[1] << 16) | (signature[2] << 8) | signature[3];
  if (type !== LMOTS_TYPE) return null;
  const a = digits(messageHash(id, q, signature.slice(4, 4 + N), message));
  const ends: Uint8Array[] = [];
  for (let i = 0; i < P; i++) ends.push(chain(id, q, i, a[i], MAX_DIGIT, signature.slice(4 + N * (i + 1), 4 + N * (i + 2))));
  return h(id, u32be(q), D_PBLC, ...ends);
}
