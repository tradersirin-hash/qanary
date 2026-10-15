//! LM-OTS one-time signatures (RFC 8554), parameter set LMOTS_SHA256_N24_W8 from NIST SP 800-208:
//! SHA-256 truncated to 24 bytes, Winternitz parameter w = 8, p = 26 hash chains, 652-byte signatures.
//!
//! Hash-based, so it does not rely on elliptic curves or lattices: its security rests only on SHA-256.
//! Each key may sign exactly one message. Qanary Vault enforces that by rotating to a pre-committed
//! next key after every signed action.

use solana_sha256_hasher::hashv;

/// Bytes per hash output (SHA-256/192).
pub const N: usize = 24;
/// Number of hash chains: 24 message digits plus 2 checksum digits.
pub const P: usize = 26;
/// LMOTS_SHA256_N24_W8 typecode (NIST SP 800-208).
pub const LMOTS_TYPE: u32 = 0x0000_0008;
/// u32str(type) || C || y[0] || ... || y[p-1]
pub const SIG_LEN: usize = 4 + N * (P + 1);
/// LM-OTS key pair identifier `I`.
pub const ID_LEN: usize = 16;

// Account fields and instruction arguments spell these sizes as literals (the IDL needs them); keep them in sync.
const _: () = assert!(N == 24 && ID_LEN == 16);

const D_PBLC: [u8; 2] = [0x80, 0x80];
const D_MESG: [u8; 2] = [0x81, 0x81];
/// Highest chain index: 2^w - 1.
const MAX_DIGIT: u8 = u8::MAX;

pub type Hash = [u8; N];

fn h(parts: &[&[u8]]) -> Hash {
    let full = hashv(parts).to_bytes();
    let mut out = [0u8; N];
    out.copy_from_slice(&full[..N]);
    out
}

/// coef(Q || Cksm(Q), i, 8) for every i. With w = 8 a digit is a byte and the checksum shift ls is 0.
fn digits(q: &Hash) -> [u8; P] {
    let mut d = [0u8; P];
    d[..N].copy_from_slice(q);
    let sum: u16 = q.iter().map(|&b| u16::from(MAX_DIGIT - b)).sum();
    d[N..].copy_from_slice(&sum.to_be_bytes());
    d
}

fn message_hash(id: &[u8; ID_LEN], q: u32, c: &[u8], message: &[u8]) -> Hash {
    h(&[id, &q.to_be_bytes(), &D_MESG, c, message])
}

/// Applies the chain function for steps `from..to` (RFC 8554: tmp = H(I || u32str(q) || u16str(i) || u8str(j) || tmp)).
fn chain(id: &[u8; ID_LEN], q: u32, i: u16, from: u8, to: u8, start: &Hash) -> Hash {
    let mut buf = [0u8; ID_LEN + 4 + 2 + 1 + N];
    buf[..ID_LEN].copy_from_slice(id);
    buf[ID_LEN..ID_LEN + 4].copy_from_slice(&q.to_be_bytes());
    buf[ID_LEN + 4..ID_LEN + 6].copy_from_slice(&i.to_be_bytes());
    let mut tmp = *start;
    for j in from..to {
        buf[ID_LEN + 6] = j;
        buf[ID_LEN + 7..].copy_from_slice(&tmp);
        tmp = h(&[&buf]);
    }
    tmp
}

fn public_key_from_ends(id: &[u8; ID_LEN], q: u32, ends: &[Hash; P]) -> Hash {
    let q_bytes = q.to_be_bytes();
    let mut parts: [&[u8]; 3 + P] = [&[]; 3 + P];
    parts[0] = id;
    parts[1] = &q_bytes;
    parts[2] = &D_PBLC;
    for (slot, end) in parts[3..].iter_mut().zip(ends.iter()) {
        *slot = end;
    }
    h(&parts)
}

/// RFC 8554 Algorithm 4b: the public key `K` this signature would verify against, or `None` if malformed.
pub fn candidate_public_key(id: &[u8; ID_LEN], q: u32, message: &[u8], signature: &[u8]) -> Option<Hash> {
    if signature.len() != SIG_LEN || signature[..4] != LMOTS_TYPE.to_be_bytes() {
        return None;
    }
    let c = &signature[4..4 + N];
    let a = digits(&message_hash(id, q, c, message));
    let mut ends = [[0u8; N]; P];
    for (i, end) in ends.iter_mut().enumerate() {
        let start = 4 + N * (i + 1);
        let mut y = [0u8; N];
        y.copy_from_slice(&signature[start..start + N]);
        *end = chain(id, q, i as u16, a[i], MAX_DIGIT, &y);
    }
    Some(public_key_from_ends(id, q, &ends))
}

/// RFC 8554 Algorithm 4a.
pub fn verify(id: &[u8; ID_LEN], q: u32, message: &[u8], signature: &[u8], public_key: &Hash) -> bool {
    candidate_public_key(id, q, message, signature).is_some_and(|k| k == *public_key)
}

/// Hash chain steps a verifier performs for this signature (it drives the compute cost).
pub fn verify_work(id: &[u8; ID_LEN], q: u32, message: &[u8], c: &[u8]) -> u32 {
    digits(&message_hash(id, q, c, message)).iter().map(|&d| u32::from(MAX_DIGIT - d)).sum()
}

/// Signing and key generation run off-chain (wallet side and tests), never inside the program.
#[cfg(not(target_os = "solana"))]
pub mod signer {
    use super::*;

    /// RFC 8554 Appendix A: x_q[i] = H(I || u32str(q) || u16str(i) || u8str(0xff) || SEED).
    fn secret(id: &[u8; ID_LEN], q: u32, i: u16, seed: &Hash) -> Hash {
        h(&[id, &q.to_be_bytes(), &i.to_be_bytes(), &[0xff], seed])
    }

    /// Public key `K` of one-time key number `q`.
    pub fn public_key(id: &[u8; ID_LEN], q: u32, seed: &Hash) -> Hash {
        let mut ends = [[0u8; N]; P];
        for (i, end) in ends.iter_mut().enumerate() {
            *end = chain(id, q, i as u16, 0, MAX_DIGIT, &secret(id, q, i as u16, seed));
        }
        public_key_from_ends(id, q, &ends)
    }

    /// Signs `message` with one-time key `q`. `c` is the n-byte randomizer; the caller must use
    /// each `q` for exactly one message.
    pub fn sign(id: &[u8; ID_LEN], q: u32, seed: &Hash, message: &[u8], c: &Hash) -> Vec<u8> {
        let a = digits(&message_hash(id, q, c, message));
        let mut sig = Vec::with_capacity(SIG_LEN);
        sig.extend_from_slice(&LMOTS_TYPE.to_be_bytes());
        sig.extend_from_slice(c);
        for i in 0..P {
            sig.extend_from_slice(&chain(id, q, i as u16, 0, a[i], &secret(id, q, i as u16, seed)));
        }
        sig
    }
}

#[cfg(test)]
mod tests {
    use super::{signer::*, *};

    const ID: [u8; ID_LEN] = [7; ID_LEN];
    const SEED: Hash = [42; N];

    #[test]
    fn sign_then_verify() {
        let k = public_key(&ID, 3, &SEED);
        let sig = sign(&ID, 3, &SEED, b"hello", &[1; N]);
        assert_eq!(sig.len(), SIG_LEN);
        assert!(verify(&ID, 3, b"hello", &sig, &k));
    }

    #[test]
    fn rejects_other_message_key_index_or_tampering() {
        let k = public_key(&ID, 3, &SEED);
        let sig = sign(&ID, 3, &SEED, b"hello", &[1; N]);
        assert!(!verify(&ID, 3, b"hellp", &sig, &k));
        assert!(!verify(&ID, 4, b"hello", &sig, &k));
        assert!(!verify(&[8; ID_LEN], 3, b"hello", &sig, &k));
        let mut bad = sig.clone();
        bad[100] ^= 1;
        assert!(!verify(&ID, 3, b"hello", &bad, &k));
        assert!(candidate_public_key(&ID, 3, b"hello", &sig[..SIG_LEN - 1]).is_none());
        let mut wrong_type = sig;
        wrong_type[3] = 4;
        assert!(candidate_public_key(&ID, 3, b"hello", &wrong_type).is_none());
    }

    /// Known answer shared with the browser signer (app/src/lib/lmots.ts), so both sides agree byte for byte.
    #[test]
    fn matches_typescript_signer() {
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        let k = public_key(&ID, 3, &SEED);
        assert_eq!(hex(&k), "d3a3647eb7e32a772106f3935ab16bb82aec44f883e47fcf");
        let sig = sign(&ID, 3, &SEED, b"hello", &[1; N]);
        assert_eq!(
            hex(&hashv(&[&sig]).to_bytes()),
            "7bc52378563d816a1bc09818f6f20f4b771dd1b5ef9487a38f621ea5769cdf64"
        );
    }

    #[test]
    fn checksum_matches_rfc_definition() {
        let q = [0u8; N];
        let d = digits(&q);
        assert_eq!(u16::from_be_bytes([d[N], d[N + 1]]), 24 * 255);
    }

    /// xorshift64*: deterministic, so a failure reproduces from its iteration number.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
        fn bytes(&mut self, len: usize) -> Vec<u8> {
            (0..len).map(|_| self.next() as u8).collect()
        }
        fn array<const L: usize>(&mut self) -> [u8; L] {
            self.bytes(L).try_into().unwrap()
        }
    }

    #[test]
    fn random_keys_and_messages_sign_and_verify_and_any_flipped_bit_breaks_it() {
        let mut rng = Rng(0x5eed_0f_9a_ab);
        for round in 0..64 {
            let id: [u8; ID_LEN] = rng.array();
            let seed: Hash = rng.array();
            let c: Hash = rng.array();
            let q = rng.next() as u32;
            let len = rng.below(300);
            let message = rng.bytes(len);
            let k = public_key(&id, q, &seed);
            let sig = sign(&id, q, &seed, &message, &c);
            assert!(verify(&id, q, &message, &sig, &k), "round {round}");
            assert!(verify_work(&id, q, &message, &c) <= (P as u32) * u32::from(MAX_DIGIT));

            let mut bad = sig.clone();
            let bit = rng.below(SIG_LEN * 8);
            bad[bit / 8] ^= 1 << (bit % 8);
            assert!(!verify(&id, q, &message, &bad, &k), "round {round}: signature bit {bit}");

            let mut other = message.clone();
            if other.is_empty() {
                other.push(0);
            } else {
                let bit = rng.below(other.len() * 8);
                other[bit / 8] ^= 1 << (bit % 8);
            }
            assert!(!verify(&id, q, &other, &sig, &k), "round {round}: message");

            let mut other_id = id;
            other_id[rng.below(ID_LEN)] ^= 1 << rng.below(8);
            assert!(!verify(&other_id, q, &message, &sig, &k), "round {round}: id");
            assert!(!verify(&id, q ^ (1 << rng.below(32)), &message, &sig, &k), "round {round}: key index");
        }
    }

    #[test]
    fn arbitrary_bytes_never_panic_or_verify() {
        let mut rng = Rng(0xbad_5_19);
        let k = public_key(&ID, 3, &SEED);
        for _ in 0..500 {
            let len = if rng.below(2) == 0 { SIG_LEN } else { rng.below(2 * SIG_LEN) };
            let mut junk = rng.bytes(len);
            if len >= 4 && rng.below(2) == 0 {
                junk[..4].copy_from_slice(&LMOTS_TYPE.to_be_bytes());
            }
            let len = rng.below(64);
            let message = rng.bytes(len);
            let _ = candidate_public_key(&ID, rng.next() as u32, &message, &junk);
            assert!(!verify(&ID, 3, &message, &junk, &k));
        }
    }
}
