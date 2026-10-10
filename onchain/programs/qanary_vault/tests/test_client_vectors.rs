//! Vectors produced by the browser client (app/src/lib/qanary.ts and lmots.ts): the message it
//! builds must equal `Action::message`, and its deterministic signature must verify here.

use {
    anchor_lang::prelude::Pubkey,
    qanary_vault::{
        lmots::{self, signer},
        state::Action,
    },
    std::str::FromStr,
};

const CLIENT_MESSAGE: &str = "71616e6172792d7661756c742d763101be38fa85ccca8879d436ecffc947dd20309520c22a342f651da7ad153d89993048c01b5059005455d9dcb0c6bcecdcb4fb5b2eabc1a9a82b57392baaa40f04e600000005e443517fba9c6628699e582ff0f5e6969d51446cf20f5cc2c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6115cd5b0700000000";
const CLIENT_SIGNATURE: &str = "000000082f40306bf14d240479307f8ab1e57b126ab943e2554d5156e998f4d3525727965a0a31749fbce4347242db8974aa91cde7ec9193d75513842d620f6afa1781a2b6b5d890bdb47121ef96a588122ece4bf01b72325bc1975b00dd729d9fd0248282a81ef97766439547e5bcb9149cc39f23a9debff9acd555c32bc43da3f5020a3ab00f4b8fc8f68471faaa89dc93a7e2a04bc340ea0739f4579784ae975396586e936ab80ab79f1a4c8637daebafe93c2d1a810caea0b76608ffc9ab8e42aebccc989525e60b5ef9703d9d1ec3fe773a36df83ec77c08a81af3a67a91841f18beeb83d3622551173ec3649a51e9b8cdce84d1f0741616448eda95926c24bfe9c126ed5ba0b28bb7799d0f6677704c4875ad826fc585bab668a1b1e6b7b63e7299f13b658af870cc2b055a118ec768c02313cb4465e89250887081e061e7ddb138118c7287584746681a08af42c8e3fac30e217d93a183c56a259bf4b67432c9474bbcfc354fd7707c036c73dd0751d926b70a6c4dfb659e7d3d817e6d162cadc070effa70a2b919a8bc781ecafb2cb9e21cad9209ee36fce45e7f66b6ed3bde11457acf7d7fab40d196a6da6bea47a126d65edf0b25badf2bb9fbc7db4ad4a0b64b6060d7b564d8077350492068b577a1cb4eaa753a75139c922eea4501629b2bdb89e7684fc15d35dd2f3da6b2b44ef883ced447ff950c5aa55713bffa92ba50832d9266e951d41c821fae244372fffc9c795eeb3b49370a87e077a8b64026f0407572d77821848e554cf6878653b768056f2ce63b2f083e05db21b53a93206dbdc049b17b18365f57b97619d5178d236e88b43ab5d46bc35909399849d3c1036b858b0a7b94f6f07b7c7668a7e3b21a3eb2e0ca2a8f22c311714bf7165dc00b055c1b2132cb983";

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn browser_message_and_signature_match_the_program() {
    let id = [7u8; lmots::ID_LEN];
    let seed = [42u8; lmots::N];
    let vault = Pubkey::from_str("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9").unwrap();
    let destination = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();
    let next = signer::public_key(&id, 6, &seed);

    let message = Action::WithdrawSol { destination, amount: 123_456_789 }.message(&vault, 5, &next);
    assert_eq!(message, unhex(CLIENT_MESSAGE));

    let signature = unhex(CLIENT_SIGNATURE);
    assert_eq!(signature.len(), lmots::SIG_LEN);
    assert!(lmots::verify(&id, 5, &message, &signature, &signer::public_key(&id, 5, &seed)));
}
