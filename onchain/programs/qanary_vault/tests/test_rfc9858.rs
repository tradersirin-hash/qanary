//! RFC 9858 Appendix A.1 (Test Case 1, SHA-256/192): an LMS_SHA256_M24_H5 tree of
//! LMOTS_SHA256_N24_W8 keys, the exact parameter set the vault uses. Independent of this project, it
//! checks the verifier (signature -> LM-OTS public key -> Merkle root) and the signer (RFC 8554
//! Appendix A key derivation, then a byte-exact signature).

use {qanary_vault::lmots::{self, signer}, solana_sha256_hasher::hashv};

const SEED: &str = "000102030405060708090a0b0c0d0e0f1011121314151617";
const I: &str = "202122232425262728292a2b2c2d2e2f";
/// HSS/LMS public key: the root of the height-5 Merkle tree.
const ROOT: &str = "2c571450aed99cfb4f4ac285da14882796618314508b12d2";
/// "Test message for SHA256-192\n"
const MESSAGE: &str = "54657374206d65737361676520666f72205348413235362d3139320a";
/// Leaf index q of the one-time key that signed.
const Q: u32 = 0x00000005;
const C: &str = "0b5040a18c1b5cabcbc85b047402ec6294a30dd8da8fc3da";
/// y[0] || ... || y[25]
const Y: &str = concat!(
    "e13b9f0875f09361dc77fcc4481ea463c073716249719193614b835b4694c059f12d3aedd34f3db93f3580fb88743b8b",
    "3d0648c0537b7a50e433d7ea9d6672fffc5f42770feab4f98eb3f3b23fd2061e4d0b38f832860ae76673ad1a1a52a900",
    "5dcf1bfb56fe16ff723627612f9a48f790f3c47a67f870b81e919d99919c8db48168838cece0abfb683da48b9209868b",
    "e8ec10c63d8bf80d36498dfc205dc45d0dd870572d6d8f1d90177cf5137b8bbf7bcb67a46f86f26cfa5a44cbcaa4e18d",
    "a099a98b0b3f96d5ac8ac375d8da2a7c248004ba11d7ac775b9218359cddab4cf8ccc6d54cb7e1b35a36ddc9265c0870",
    "63d2fc6742a7177876476a324b03295bfed99f2eaf1f38970583c1b2b616aad0f31cd7a4b1bb0a51e477e94a01bbb4d6",
    "f8866e2528a159df3d6ce244d2b6518d1f0212285a3c2d4a927054a1e1620b5b02aab0c8c10ed48ae518ea73cba81fcf",
    "ff88bff461dac51e7ab4ca75f47a6259d24820b9995792d139f61ae2a8186ae4e3c9bfe0af2cc717f424f41aa67f03fa",
    "edb0665115f2067a46843a4cbbd297d5e83bc1aafc18d1d03b3d894e8595a6526073f02ab0f08b99fd9eb208b59ff631",
    "7e5545e6f9ad5f9c183abd043d5acd6eb2dd4da3f02dbc3167b468720a4b8b92ddfe7960998bb7a0ecf2a26a37598299",
    "413f7b2aecd39a30cec527b4d9710c4473639022451f50d01c0457125da0fa4429c07dad859c846cbbd93ab5b91b01bc",
    "770b089cfede6f651e86dd7c15989c8b5321dea9ca608c71fd862323072b827cee7a7e28e4e2b999647233c3456944bb",
    "7aef9187c96b3f5b79fb98bc76c3574dd06f0e95685e5b3aef3a54c4155fe3ad817749629c30adbe897c4f4454c86c49",
);
const PATH: [&str; 5] = [
    "e9ca10eaa811b22ae07fb195e3590a334ea64209942fbae3",
    "38d19f152182c807d3c40b189d3fcbea942f44682439b191",
    "332d33ae0b761a2a8f984b56b2ac2fd4ab08223a69ed1f77",
    "19c7aa7e9eee96504b0e60c6bb5c942d695f0493eb25f80a",
    "5871cffd131d0e04ffe5065bc7875e82d34b40b69dd9f3c1",
];

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn arr<const L: usize>(s: &str) -> [u8; L] {
    hex(s).try_into().unwrap()
}

fn h(parts: &[&[u8]]) -> lmots::Hash {
    hashv(parts).to_bytes()[..lmots::N].try_into().unwrap()
}

fn ots_signature() -> Vec<u8> {
    [&lmots::LMOTS_TYPE.to_be_bytes()[..], &hex(C), &hex(Y)].concat()
}

/// RFC 8554 Algorithm 6a, steps 3-4: from the LM-OTS public key up the authentication path to the root.
fn lms_root(id: &[u8; lmots::ID_LEN], q: u32, ots_public_key: &lmots::Hash) -> lmots::Hash {
    const H: u32 = 5;
    let mut node = (1u32 << H) + q;
    let mut tmp = h(&[id, &node.to_be_bytes(), &[0x82, 0x82], ots_public_key]);
    for sibling in PATH.iter().map(|p| hex(p)) {
        let parent = (node / 2).to_be_bytes();
        tmp = if node % 2 == 1 {
            h(&[id, &parent, &[0x83, 0x83], &sibling, &tmp])
        } else {
            h(&[id, &parent, &[0x83, 0x83], &tmp, &sibling])
        };
        node /= 2;
    }
    tmp
}

#[test]
fn verifier_recovers_the_rfc_9858_public_key() {
    let id = arr::<{ lmots::ID_LEN }>(I);
    let sig = ots_signature();
    assert_eq!(sig.len(), lmots::SIG_LEN);
    let k = lmots::candidate_public_key(&id, Q, &hex(MESSAGE), &sig).expect("well-formed");
    assert_eq!(lms_root(&id, Q, &k), arr::<{ lmots::N }>(ROOT));

    // One flipped message bit no longer reaches the published root.
    let mut other = hex(MESSAGE);
    other[0] ^= 1;
    let k = lmots::candidate_public_key(&id, Q, &other, &sig).unwrap();
    assert_ne!(lms_root(&id, Q, &k), arr::<{ lmots::N }>(ROOT));
}

#[test]
fn signer_reproduces_the_rfc_9858_signature() {
    let id = arr::<{ lmots::ID_LEN }>(I);
    let seed = arr::<{ lmots::N }>(SEED);
    let sig = signer::sign(&id, Q, &seed, &hex(MESSAGE), &arr::<{ lmots::N }>(C));
    assert_eq!(sig, ots_signature());
    assert_eq!(lms_root(&id, Q, &signer::public_key(&id, Q, &seed)), arr::<{ lmots::N }>(ROOT));
}
