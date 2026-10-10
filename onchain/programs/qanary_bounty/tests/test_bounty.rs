use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    qanary_bounty::{state::Canary, CANARY_KEY, CANARY_SEED},
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_transaction::Transaction,
};

const SOL: u64 = 1_000_000_000;

fn canary_pda() -> Pubkey {
    Pubkey::find_program_address(&[CANARY_SEED], &qanary_bounty::id()).0
}

fn setup(sigverify: bool) -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new().with_sigverify(sigverify);
    // Loaded at run time so `anchor build` can compile this test before the .so exists.
    let so = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("../deploy/qanary_bounty.so");
    svm.add_program_from_file(qanary_bounty::id(), so).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10 * SOL).unwrap();
    let ix = Instruction::new_with_bytes(
        qanary_bounty::id(),
        &qanary_bounty::instruction::Initialize {}.data(),
        qanary_bounty::accounts::Initialize {
            payer: payer.pubkey(),
            canary: canary_pda(),
            honeypot: CANARY_KEY,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &payer, ix).expect("initialize");
    (svm, payer)
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> Result<(), String> {
    let tx = Transaction::new(&[payer], Message::new(&[ix], Some(&payer.pubkey())), svm.latest_blockhash());
    let res = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err));
    svm.expire_blockhash();
    res
}

fn canary(svm: &LiteSVM) -> Canary {
    let account = svm.get_account(&canary_pda()).unwrap();
    Canary::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn fund_ix(funder: &Pubkey, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        qanary_bounty::id(),
        &qanary_bounty::instruction::Fund { amount }.data(),
        qanary_bounty::accounts::Fund { funder: *funder, canary: canary_pda(), system_program: system_program::ID }.to_account_metas(None),
    )
}

fn check_ix() -> Instruction {
    Instruction::new_with_bytes(
        qanary_bounty::id(),
        &qanary_bounty::instruction::CheckHoneypot {}.data(),
        qanary_bounty::accounts::CheckHoneypot { honeypot: CANARY_KEY, canary: canary_pda() }.to_account_metas(None),
    )
}

fn set_honeypot(svm: &mut LiteSVM, lamports: u64) {
    svm.set_account(CANARY_KEY, Account { lamports, data: vec![], owner: system_program::ID, executable: false, rent_epoch: 0 })
        .unwrap();
}

#[test]
fn fund_accumulates_and_canary_starts_alive() {
    let (mut svm, payer) = setup(true);
    send(&mut svm, &payer, fund_ix(&payer.pubkey(), 2 * SOL)).unwrap();
    send(&mut svm, &payer, fund_ix(&payer.pubkey(), SOL)).unwrap();
    let c = canary(&svm);
    assert!(!c.tripped);
    assert_eq!(c.total_funded, 3 * SOL);
    assert!(send(&mut svm, &payer, fund_ix(&payer.pubkey(), 0)).is_err());
}

#[test]
fn drained_honeypot_trips_the_canary() {
    let (mut svm, payer) = setup(true);
    set_honeypot(&mut svm, 5 * SOL);
    send(&mut svm, &payer, check_ix()).unwrap();
    assert_eq!(canary(&svm).honeypot_baseline, 5 * SOL);

    // More SOL in the honeypot only raises the baseline.
    set_honeypot(&mut svm, 6 * SOL);
    send(&mut svm, &payer, check_ix()).unwrap();
    assert_eq!(canary(&svm).honeypot_baseline, 6 * SOL);
    assert!(!canary(&svm).tripped);

    // Only the canary key can lower its own balance, so a drop means the key was broken.
    set_honeypot(&mut svm, 6 * SOL - 1);
    send(&mut svm, &payer, check_ix()).unwrap();
    let c = canary(&svm);
    assert!(c.tripped);
    assert_eq!(c.claimer, Pubkey::default());

    assert!(send(&mut svm, &payer, fund_ix(&payer.pubkey(), SOL)).is_err(), "funding stops after a trip");
}

fn fund_honeypot_ix(funder: &Pubkey, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        qanary_bounty::id(),
        &qanary_bounty::instruction::FundHoneypot { amount }.data(),
        qanary_bounty::accounts::FundHoneypot {
            funder: *funder,
            honeypot: CANARY_KEY,
            canary: canary_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

#[test]
fn fund_honeypot_records_the_deposit_atomically() {
    let (mut svm, payer) = setup(true);
    send(&mut svm, &payer, fund_honeypot_ix(&payer.pubkey(), 2 * SOL)).unwrap();
    assert_eq!(svm.get_account(&CANARY_KEY).unwrap().lamports, 2 * SOL);
    assert_eq!(canary(&svm).honeypot_baseline, 2 * SOL);

    // A drain before the next deposit trips the canary instead of being absorbed into the baseline.
    set_honeypot(&mut svm, SOL);
    send(&mut svm, &payer, fund_honeypot_ix(&payer.pubkey(), SOL)).unwrap();
    assert!(canary(&svm).tripped);
    assert_eq!(svm.get_account(&CANARY_KEY).unwrap().lamports, SOL, "no deposit after a trip");
}

fn claim_tx(svm: &LiteSVM, payer: &Keypair, recipient: &Pubkey) -> Transaction {
    let ix = Instruction::new_with_bytes(
        qanary_bounty::id(),
        &qanary_bounty::instruction::Claim {}.data(),
        qanary_bounty::accounts::Claim { canary_key: CANARY_KEY, recipient: *recipient, canary: canary_pda() }.to_account_metas(None),
    );
    let blockhash = svm.latest_blockhash();
    let mut tx = Transaction::new_unsigned(Message::new(&[ix], Some(&payer.pubkey())));
    // Nobody can produce CANARY_KEY's signature; its slot stays empty.
    tx.partial_sign(&[payer], blockhash);
    tx
}

#[test]
fn claim_without_the_canary_signature_is_rejected() {
    let (mut svm, payer) = setup(true);
    send(&mut svm, &payer, fund_ix(&payer.pubkey(), SOL)).unwrap();
    let recipient = Pubkey::new_unique();
    assert!(svm.send_transaction(claim_tx(&svm, &payer, &recipient)).is_err());
    assert!(!canary(&svm).tripped);
}

#[test]
fn valid_claim_pays_the_pool_and_trips() {
    // Signature checks off: stands in for an attacker who can sign for CANARY_KEY.
    let (mut svm, payer) = setup(false);
    send(&mut svm, &payer, fund_ix(&payer.pubkey(), 3 * SOL)).unwrap();
    let recipient = Pubkey::new_unique();
    let pool_before = svm.get_account(&canary_pda()).unwrap().lamports;

    svm.send_transaction(claim_tx(&svm, &payer, &recipient)).expect("claim");

    let c = canary(&svm);
    assert!(c.tripped);
    assert_eq!(c.claimer, recipient);
    let paid = svm.get_account(&recipient).unwrap().lamports;
    let rent_left = svm.get_account(&canary_pda()).unwrap().lamports;
    assert_eq!(paid + rent_left, pool_before);
    assert!(paid >= 3 * SOL);
}
