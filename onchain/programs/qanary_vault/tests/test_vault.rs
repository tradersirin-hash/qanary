use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    qanary_bounty::{CANARY_KEY, CANARY_SEED},
    qanary_vault::{
        lmots::{self, signer},
        state::{skip, Action, Vault},
        VAULT_SEED,
    },
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_transaction::Transaction,
};

const SOL: u64 = 1_000_000_000;
const ID: [u8; lmots::ID_LEN] = *b"qanary-test-vlt1";
const SEED: lmots::Hash = [9; lmots::N];
const COMPUTE_BUDGET: Pubkey = anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111");

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    owner: Keypair,
    vault: Pubkey,
    /// Logs of the last successful transaction.
    logs: Vec<String>,
}

fn key(q: u32) -> lmots::Hash {
    signer::public_key(&ID, q, &SEED)
}

fn vault_pda(id: &[u8; 16], genesis: &lmots::Hash) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, id, genesis], &qanary_vault::id()).0
}

fn canary_pda() -> Pubkey {
    Pubkey::find_program_address(&[CANARY_SEED], &qanary_bounty::id()).0
}

fn cu_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET, &data, vec![])
}

fn create_ix(payer: &Pubkey, id: [u8; 16], genesis: lmots::Hash) -> Instruction {
    Instruction::new_with_bytes(
        qanary_vault::id(),
        &qanary_vault::instruction::CreateVault { id, key: genesis }.data(),
        qanary_vault::accounts::CreateVault { payer: *payer, vault: vault_pda(&id, &genesis), system_program: system_program::ID }
            .to_account_metas(None),
    )
}

impl Env {
    /// A funded vault (10 SOL); with `with_owner`, key 0 has been spent to add a classical owner.
    fn new(with_owner: bool) -> Self {
        let mut svm = LiteSVM::new();
        // Loaded at run time: `anchor build` compiles these tests while generating the IDL,
        // possibly before the other program's .so exists.
        let deploy = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("../deploy");
        svm.add_program_from_file(qanary_vault::id(), deploy.join("qanary_vault.so")).unwrap();
        svm.add_program_from_file(qanary_bounty::id(), deploy.join("qanary_bounty.so")).unwrap();
        let payer = Keypair::new();
        let owner = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100 * SOL).unwrap();
        svm.airdrop(&owner.pubkey(), SOL).unwrap();
        let vault = vault_pda(&ID, &key(0));
        let mut env = Env { svm, payer, owner, vault, logs: vec![] };

        env.send(
            &[Instruction::new_with_bytes(
                qanary_bounty::id(),
                &qanary_bounty::instruction::Initialize {}.data(),
                qanary_bounty::accounts::Initialize {
                    payer: env.payer.pubkey(),
                    canary: canary_pda(),
                    honeypot: CANARY_KEY,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            )],
            &[],
        )
        .expect("init canary");

        let create = create_ix(&env.payer.pubkey(), ID, key(0));
        env.send(&[create], &[]).expect("create vault");
        let v = env.state();
        assert_eq!((v.nonce, v.key, v.genesis_key, v.owner), (0, key(0), key(0), None));

        // Anyone can deposit with a plain SOL transfer to the vault address.
        let deposit = anchor_lang::solana_program::system_instruction::transfer(&env.payer.pubkey(), &vault, 10 * SOL);
        env.send(&[deposit], &[]).expect("deposit");

        if with_owner {
            let owner = Some(env.owner.pubkey());
            env.pq_set_owner(owner).expect("add owner");
            assert_eq!(env.state().owner, owner);
        }
        env
    }

    /// Sends a transaction paid by `payer`; returns compute units used.
    fn send(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Result<u64, String> {
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new(&signers, Message::new(ixs, Some(&self.payer.pubkey())), self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx).map_err(|e| format!("{:?}", e.err));
        self.svm.expire_blockhash();
        res.map(|m| {
            self.logs = m.logs;
            m.compute_units_consumed
        })
    }

    fn skipped(&self) -> Option<u8> {
        skip_reason(&self.logs)
    }

    fn state(&self) -> Vault {
        Vault::try_deserialize(&mut self.svm.get_account(&self.vault).unwrap().data.as_slice()).unwrap()
    }

    fn nonce(&self) -> u32 {
        self.state().nonce
    }

    fn balance(&self, who: &Pubkey) -> u64 {
        self.svm.get_account(who).map(|a| a.lamports).unwrap_or(0)
    }

    fn sign(&self, q: u32, next: &lmots::Hash, action: &Action) -> Vec<u8> {
        signer::sign(&ID, q, &SEED, &action.message(&self.vault, q, next), &[q as u8; lmots::N])
    }

    fn pq_withdraw_sol(&mut self, signature: Vec<u8>, destination: Pubkey, amount: u64, next_key: lmots::Hash) -> Result<u64, String> {
        self.pq_withdraw_sol_meta(signature, destination, amount, next_key, true)
    }

    /// The program does not mark the destination `mut` (see `PqWithdrawSol`), so clients pass it writable.
    fn pq_withdraw_sol_meta(
        &mut self,
        signature: Vec<u8>,
        destination: Pubkey,
        amount: u64,
        next_key: lmots::Hash,
        writable: bool,
    ) -> Result<u64, String> {
        let mut metas = qanary_vault::accounts::PqWithdrawSol { vault: self.vault, destination }.to_account_metas(None);
        metas[1].is_writable = writable;
        let ix = Instruction::new_with_bytes(
            qanary_vault::id(),
            &qanary_vault::instruction::PqWithdrawSol { signature, amount, next_key }.data(),
            metas,
        );
        self.send(&[cu_limit(1_400_000), ix], &[])
    }

    /// Signs and sends a withdrawal with the current key.
    fn withdraw(&mut self, destination: Pubkey, amount: u64) -> Result<u64, String> {
        let q = self.nonce();
        let sig = self.sign(q, &key(q + 1), &Action::WithdrawSol { destination, amount });
        self.pq_withdraw_sol(sig, destination, amount, key(q + 1))
    }

    fn pq_set_owner(&mut self, owner: Option<Pubkey>) -> Result<u64, String> {
        let q = self.nonce();
        let sig = self.sign(q, &key(q + 1), &Action::SetOwner { owner });
        let ix = Instruction::new_with_bytes(
            qanary_vault::id(),
            &qanary_vault::instruction::PqSetOwner { signature: sig, owner, next_key: key(q + 1) }.data(),
            qanary_vault::accounts::PqSetOwner { vault: self.vault }.to_account_metas(None),
        );
        self.send(&[cu_limit(1_400_000), ix], &[])
    }

    fn classic_withdraw_sol(&mut self, signer: &Keypair, destination: Pubkey, amount: u64) -> Result<u64, String> {
        let ix = Instruction::new_with_bytes(
            qanary_vault::id(),
            &qanary_vault::instruction::WithdrawSol { amount }.data(),
            qanary_vault::accounts::WithdrawSol { vault: self.vault, owner: signer.pubkey(), destination, canary: canary_pda() }
                .to_account_metas(None),
        );
        let signer = signer.insecure_clone();
        self.send(&[ix], &[&signer])
    }

    fn trip_canary(&mut self) {
        let check = Instruction::new_with_bytes(
            qanary_bounty::id(),
            &qanary_bounty::instruction::CheckHoneypot {}.data(),
            qanary_bounty::accounts::CheckHoneypot { honeypot: CANARY_KEY, canary: canary_pda() }.to_account_metas(None),
        );
        for lamports in [5 * SOL, 4 * SOL] {
            self.svm
                .set_account(CANARY_KEY, Account { lamports, data: vec![], owner: system_program::ID, executable: false, rent_epoch: 0 })
                .unwrap();
            self.send(&[check.clone()], &[]).unwrap();
        }
    }
}

#[test]
fn pq_withdraw_moves_sol_and_rotates_the_key() {
    let mut env = Env::new(false);
    let dest = Pubkey::new_unique();
    let sig = env.sign(0, &key(1), &Action::WithdrawSol { destination: dest, amount: 2 * SOL });
    assert_eq!(sig.len(), lmots::SIG_LEN);

    let cu = env.pq_withdraw_sol(sig.clone(), dest, 2 * SOL, key(1)).expect("pq withdraw");
    println!("pq_withdraw_sol compute units: {cu}");
    assert!(cu < 1_400_000);

    assert_eq!(env.balance(&dest), 2 * SOL);
    let v = env.state();
    assert_eq!((v.nonce, v.key, v.genesis_key), (1, key(1), key(0)));

    // The same signature cannot be replayed: key 0 is gone.
    assert!(env.pq_withdraw_sol(sig, dest, 2 * SOL, key(1)).is_err());

    env.withdraw(dest, SOL).expect("second pq withdraw");
    assert_eq!(env.balance(&dest), 3 * SOL);
    assert_eq!(env.nonce(), 2);
}

#[test]
fn pq_signature_is_bound_to_amount_destination_and_next_key() {
    let mut env = Env::new(false);
    let dest = Pubkey::new_unique();
    let sig = env.sign(0, &key(1), &Action::WithdrawSol { destination: dest, amount: SOL });
    assert!(env.pq_withdraw_sol(sig.clone(), dest, 2 * SOL, key(1)).is_err(), "amount changed");
    assert!(env.pq_withdraw_sol(sig.clone(), Pubkey::new_unique(), SOL, key(1)).is_err(), "destination changed");
    assert!(env.pq_withdraw_sol(sig.clone(), dest, SOL, key(2)).is_err(), "next key changed");
    assert!(env.pq_withdraw_sol(sig[..lmots::SIG_LEN - 1].to_vec(), dest, SOL, key(1)).is_err(), "truncated");
    assert_eq!(env.nonce(), 0);
    env.pq_withdraw_sol(sig, dest, SOL, key(1)).expect("original");
}

#[test]
fn verified_but_unpayable_requests_still_consume_the_key() {
    let mut env = Env::new(false);
    let dest = Pubkey::new_unique();
    let before = env.balance(&env.vault.clone());

    // More than the vault holds: verified, skipped, key rotated.
    env.withdraw(dest, 1_000 * SOL).expect("skipped, not failed");
    assert_eq!(env.skipped(), Some(skip::AMOUNT));
    // Zero.
    env.withdraw(dest, 0).expect("skipped, not failed");
    assert_eq!(env.skipped(), Some(skip::AMOUNT));
    // A brand-new destination that would end up below rent.
    env.withdraw(dest, 1_000).expect("skipped, not failed");
    assert_eq!(env.skipped(), Some(skip::RENT));

    assert_eq!(env.nonce(), 3);
    assert_eq!(env.balance(&dest), 0);
    assert_eq!(env.balance(&env.vault.clone()), before);

    // The chain keeps working.
    env.withdraw(dest, SOL).expect("key 3 works");
    assert_eq!((env.balance(&dest), env.skipped()), (SOL, None));
}

#[test]
fn next_key_must_differ() {
    let mut env = Env::new(false);
    let dest = Pubkey::new_unique();
    let sig = env.sign(0, &key(0), &Action::WithdrawSol { destination: dest, amount: SOL });
    assert!(env.pq_withdraw_sol(sig, dest, SOL, key(0)).is_err(), "key reuse");
    assert_eq!(env.nonce(), 0);
}

#[test]
fn front_runner_cannot_hijack_a_vault() {
    let mut env = Env::new(false);
    let attacker_key = signer::public_key(&ID, 0, &[1; lmots::N]);
    // Same id, attacker's key: a different address, so the victim's vault is untouched.
    let ix = create_ix(&env.payer.pubkey(), ID, attacker_key);
    env.send(&[ix], &[]).expect("attacker creates their own vault");
    assert_ne!(vault_pda(&ID, &attacker_key), env.vault);
    // Copying the exact parameters only recreates what the victim asked for, and fails as it exists.
    let ix = create_ix(&env.payer.pubkey(), ID, key(0));
    assert!(env.send(&[ix], &[]).is_err());
    assert_eq!(env.state().owner, None);
}

#[test]
fn classic_owner_works_only_while_the_canary_lives() {
    let mut env = Env::new(true);
    let dest = Pubkey::new_unique();
    let owner = env.owner.insecure_clone();
    env.classic_withdraw_sol(&owner, dest, SOL).expect("owner withdraw");
    assert_eq!(env.balance(&dest), SOL);

    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    assert!(env.classic_withdraw_sol(&stranger, dest, SOL).is_err(), "not the owner");

    env.trip_canary();
    assert!(env.classic_withdraw_sol(&owner, dest, SOL).is_err(), "classic path closed after the trip");

    env.withdraw(dest, SOL).expect("pq after trip");
    assert_eq!(env.balance(&dest), 2 * SOL);
}

#[test]
fn pq_key_can_remove_the_classical_owner() {
    let mut env = Env::new(true);
    env.pq_set_owner(None).expect("remove owner");
    assert_eq!(env.state().owner, None);
    let owner = env.owner.insecure_clone();
    assert!(env.classic_withdraw_sol(&owner, Pubkey::new_unique(), SOL).is_err(), "owner removed");
}

#[test]
fn destinations_that_cannot_receive_are_skipped_after_the_key_is_consumed() {
    let mut env = Env::new(false);
    let before = env.balance(&env.vault.clone());
    // Sysvars, programs and reserved keys (some neither executable nor sysvar-owned, some with no
    // account at all): the runtime never credits them, so the request is skipped.
    let cannot_receive = [
        anchor_lang::pubkey!("SysvarC1ock11111111111111111111111111111111"),
        qanary_vault::id(),
        anchor_lang::pubkey!("StakeConfig11111111111111111111111111111111"),
        anchor_lang::pubkey!("Sysvar1111111111111111111111111111111111111"),
        anchor_lang::pubkey!("NativeLoader1111111111111111111111111111111"),
        system_program::ID,
    ];
    for (i, dest) in cannot_receive.iter().enumerate() {
        env.withdraw(*dest, SOL).unwrap_or_else(|e| panic!("{dest} skipped, not failed: {e}"));
        assert_eq!(env.skipped(), Some(skip::DESTINATION), "{dest}");
        assert_eq!(env.nonce(), i as u32 + 1);
    }
    assert_eq!(env.balance(&env.vault.clone()), before);
}

#[test]
fn reserved_keys_match_agave() {
    let ours: std::collections::BTreeSet<String> = qanary_vault::RESERVED_KEYS.iter().map(|k| k.to_string()).collect();
    let agave: std::collections::BTreeSet<String> =
        agave_reserved_account_keys::ReservedAccountKeys::all_keys_iter().map(|k| k.to_string()).collect();
    assert_eq!(ours.len(), qanary_vault::RESERVED_KEYS.len(), "no duplicates");
    assert_eq!(ours, agave);
}

#[test]
fn a_read_only_destination_fails_before_the_key_and_a_writable_resend_works() {
    let mut env = Env::new(false);
    let dest = Pubkey::new_unique();
    let sig = env.sign(0, &key(1), &Action::WithdrawSol { destination: dest, amount: SOL });
    // Whoever submits controls the account flags, so a read-only destination must not burn the key.
    assert!(env.pq_withdraw_sol_meta(sig.clone(), dest, SOL, key(1), false).is_err());
    assert_eq!(env.nonce(), 0);
    env.pq_withdraw_sol(sig, dest, SOL, key(1)).expect("same signed bytes, writable");
    assert_eq!((env.nonce(), env.balance(&dest)), (1, SOL));
}

#[test]
fn the_verifier_fits_the_compute_limit_even_at_maximum_work() {
    // Verification cost grows with the hash-chain steps (verify_work), which the randomizer C sets. Send
    // the cheapest and the dearest of 512 randomizers, then extrapolate linearly to the worst case any
    // signature can need: 26 chains of 255 steps.
    let mut env = Env::new(false);
    let dest = Pubkey::new_unique();
    let mut points = vec![];
    for dearest in [false, true] {
        let q = env.nonce();
        let message = Action::WithdrawSol { destination: dest, amount: SOL }.message(&env.vault, q, &key(q + 1));
        let candidates = (0..512u16).map(|i| {
            let mut c = [0u8; lmots::N];
            c[..2].copy_from_slice(&i.to_be_bytes());
            c
        });
        let work = |c: &lmots::Hash| lmots::verify_work(&ID, q, &message, c);
        let c = if dearest { candidates.max_by_key(work) } else { candidates.min_by_key(work) }.unwrap();
        let sig = signer::sign(&ID, q, &SEED, &message, &c);
        let cu = env.pq_withdraw_sol(sig, dest, SOL, key(q + 1)).expect("pq withdraw");
        points.push((f64::from(work(&c)), cu as f64));
    }
    let ((w0, c0), (w1, c1)) = (points[0], points[1]);
    let per_step = (c1 - c0) / (w1 - w0);
    let worst = c1 + per_step * (f64::from(26u32 * 255) - w1);
    println!("verifier: {w0} steps = {c0} CU, {w1} steps = {c1} CU, {per_step:.1} CU/step, worst case ~{worst:.0} CU");
    assert!(w1 > w0, "the two randomizers must differ in work");
    assert!(worst < 1_400_000.0 * 0.9, "worst-case verification needs ~{worst:.0} CU");
}

/// The `ActionSkipped` reason in a transaction's logs, if the program emitted one.
fn skip_reason(logs: &[String]) -> Option<u8> {
    use anchor_lang::{AnchorDeserialize, Discriminator};
    fn b64(s: &str) -> Vec<u8> {
        let val = |c: u8| match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            _ => 63,
        };
        let digits: Vec<u8> = s.bytes().filter(|&c| c != b'=').map(val).collect();
        digits
            .chunks(4)
            .flat_map(|c| {
                let n = c.iter().enumerate().fold(0u32, |n, (i, &d)| n | (d as u32) << (18 - 6 * i));
                n.to_be_bytes()[1..c.len()].to_vec()
            })
            .collect()
    }
    logs.iter().filter_map(|l| l.strip_prefix("Program data: ")).map(b64).find_map(|d| {
        let disc = qanary_vault::state::ActionSkipped::DISCRIMINATOR;
        (d.len() > disc.len() && &d[..disc.len()] == disc)
            .then(|| qanary_vault::state::ActionSkipped::try_from_slice(&d[disc.len()..]).ok().map(|e| e.reason))
            .flatten()
    })
}
