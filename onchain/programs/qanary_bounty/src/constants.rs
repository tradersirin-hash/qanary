use anchor_lang::prelude::*;

#[constant]
pub const CANARY_SEED: &[u8] = b"canary";

/// Nothing-up-my-sleeve Ed25519 public key whose private key nobody knows:
/// 8 * decompress(SHA-256("Qanary canary v1: nobody knows the private key of this point" || 0x01)).
/// Reproduce it with `scripts/canary_key.py`; `tests/test_canary_key.rs` re-derives it with curve25519-dalek.
/// A valid signature from this key means elliptic-curve keys can be broken.
#[constant]
pub const CANARY_KEY: Pubkey = pubkey!("4H3XvrAPRRJuSaTZJt3XSRpEVPCPKJjWy69jDkx1VNwZ");
