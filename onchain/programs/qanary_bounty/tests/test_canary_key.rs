//! Re-derives CANARY_KEY with curve25519-dalek, independently of scripts/canary_key.py,
//! so anyone can check that nobody chose (and therefore nobody knows) its private key.

use curve25519_dalek::edwards::CompressedEdwardsY;
use sha2::{Digest, Sha256};

const PHRASE: &[u8] = b"Qanary canary v1: nobody knows the private key of this point";

#[test]
fn canary_key_is_nothing_up_my_sleeve() {
    let (counter, point) = (0u8..=255)
        .find_map(|counter| {
            let hash: [u8; 32] = Sha256::new().chain_update(PHRASE).chain_update([counter]).finalize().into();
            CompressedEdwardsY(hash).decompress().map(|p| (counter, p))
        })
        .expect("some counter yields a curve point");
    assert_eq!(counter, 1);

    let canary = point.mul_by_cofactor();
    assert!(!canary.is_small_order());
    assert!(canary.is_torsion_free());
    assert_eq!(canary.compress().to_bytes(), qanary_bounty::CANARY_KEY.to_bytes());
}
