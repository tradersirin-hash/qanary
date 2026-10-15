//! Post-quantum token withdrawals. A request the signature fixes but that cannot run is skipped and
//! still consumes the key; a wrong account the signature does not fix fails before the key is touched.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, program_option::COption, program_pack::Pack, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::get_associated_token_address_with_program_id,
        token_2022::spl_token_2022::{
            extension::{
                confidential_transfer::ConfidentialTransferAccount, memo_transfer::MemoTransfer,
                non_transferable::NonTransferable, pausable::PausableConfig, transfer_hook::TransferHook,
                BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
            },
            state::{Account as TokenState, AccountState, Mint as MintState},
        },
    },
    litesvm::LiteSVM,
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
const ID: [u8; lmots::ID_LEN] = *b"qanary-test-tok1";
const SEED: lmots::Hash = [7; lmots::N];
const TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const COMPUTE_BUDGET: Pubkey = anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111");
const VAULT_BALANCE: u64 = 1_000;

fn key(q: u32) -> lmots::Hash {
    signer::public_key(&ID, q, &SEED)
}

/// Optional Token-2022 extensions a test mint or destination carries.
#[derive(Clone, Copy, Default)]
struct Ext {
    non_transferable: bool,
    paused: bool,
    hook: bool,
    memo_required: bool,
    confidential_only: bool,
}

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    vault: Pubkey,
    /// Logs of the last successful transaction.
    logs: Vec<String>,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let deploy = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("../deploy");
        svm.add_program_from_file(qanary_vault::id(), deploy.join("qanary_vault.so")).unwrap();
        svm.add_program_from_file(qanary_bounty::id(), deploy.join("qanary_bounty.so")).unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100 * SOL).unwrap();
        let vault = Pubkey::find_program_address(&[VAULT_SEED, &ID, &key(0)], &qanary_vault::id()).0;
        let mut env = Env { svm, payer, vault, logs: vec![] };
        let create = Instruction::new_with_bytes(
            qanary_vault::id(),
            &qanary_vault::instruction::CreateVault { id: ID, key: key(0) }.data(),
            qanary_vault::accounts::CreateVault { payer: env.payer.pubkey(), vault, system_program: system_program::ID }
                .to_account_metas(None),
        );
        env.send(&[create]).expect("create vault");
        env
    }

    fn send(&mut self, ixs: &[Instruction]) -> Result<(), String> {
        let tx = Transaction::new(&[&self.payer], Message::new(ixs, Some(&self.payer.pubkey())), self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx).map_err(|e| format!("{:?}", e.err));
        self.svm.expire_blockhash();
        res.map(|m| self.logs = m.logs)
    }

    fn skipped(&self) -> Option<u8> {
        skip_reason(&self.logs)
    }

    fn nonce(&self) -> u32 {
        Vault::try_deserialize(&mut self.svm.get_account(&self.vault).unwrap().data.as_slice()).unwrap().nonce
    }

    fn put(&mut self, address: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(address, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    /// A mint with `ext` written straight into the account.
    fn mint(&mut self, program: Pubkey, ext: Ext) -> Pubkey {
        let mint = Pubkey::new_unique();
        let base = MintState {
            mint_authority: COption::Some(self.payer.pubkey()),
            supply: 10 * VAULT_BALANCE,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut types = vec![];
        if ext.non_transferable {
            types.push(ExtensionType::NonTransferable);
        }
        if ext.paused {
            types.push(ExtensionType::Pausable);
        }
        if ext.hook {
            types.push(ExtensionType::TransferHook);
        }
        let data = if types.is_empty() {
            let mut d = vec![0; MintState::LEN];
            base.pack_into_slice(&mut d);
            d
        } else {
            let mut d = vec![0; ExtensionType::try_calculate_account_len::<MintState>(&types).unwrap()];
            let mut s = StateWithExtensionsMut::<MintState>::unpack_uninitialized(&mut d).unwrap();
            s.base = base;
            s.pack_base();
            if ext.non_transferable {
                s.init_extension::<NonTransferable>(true).unwrap();
            }
            if ext.paused {
                s.init_extension::<PausableConfig>(true).unwrap().paused = true.into();
            }
            if ext.hook {
                s.init_extension::<TransferHook>(true).unwrap().program_id = Some(Pubkey::new_unique()).try_into().unwrap();
            }
            s.init_account_type().unwrap();
            d
        };
        self.put(mint, program, data);
        mint
    }

    /// A token account at `address` with `ext` written straight into it.
    fn token_account(&mut self, address: Pubkey, program: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64, state: AccountState, ext: Ext) {
        let base = TokenState { mint, owner, amount, state, ..TokenState::default() };
        let mut types = vec![];
        if ext.memo_required {
            types.push(ExtensionType::MemoTransfer);
        }
        if ext.confidential_only {
            types.push(ExtensionType::ConfidentialTransferAccount);
        }
        let data = if types.is_empty() {
            let mut d = vec![0; TokenState::LEN];
            base.pack_into_slice(&mut d);
            d
        } else {
            let mut d = vec![0; ExtensionType::try_calculate_account_len::<TokenState>(&types).unwrap()];
            let mut s = StateWithExtensionsMut::<TokenState>::unpack_uninitialized(&mut d).unwrap();
            s.base = base;
            s.pack_base();
            if ext.memo_required {
                s.init_extension::<MemoTransfer>(true).unwrap().require_incoming_transfer_memos = true.into();
            }
            if ext.confidential_only {
                // A fresh confidential account refuses non-confidential credits.
                s.init_extension::<ConfidentialTransferAccount>(true).unwrap();
            }
            s.init_account_type().unwrap();
            d
        };
        self.put(address, program, data);
    }

    fn ata(&self, mint: &Pubkey, program: &Pubkey) -> Pubkey {
        get_associated_token_address_with_program_id(&self.vault, mint, program)
    }

    /// The vault's associated token account holding `VAULT_BALANCE`, plus a fresh destination.
    fn funded(&mut self, program: Pubkey, mint_ext: Ext, dest_ext: Ext) -> (Pubkey, Pubkey) {
        let mint = self.mint(program, mint_ext);
        let ata = self.ata(&mint, &program);
        let vault = self.vault;
        self.token_account(ata, program, mint, vault, VAULT_BALANCE, AccountState::Initialized, Ext::default());
        let dest = Pubkey::new_unique();
        self.token_account(dest, program, mint, Pubkey::new_unique(), 0, AccountState::Initialized, dest_ext);
        (mint, dest)
    }

    fn amount(&self, account: &Pubkey) -> Option<u64> {
        let a = self.svm.get_account(account)?;
        Some(u64::from_le_bytes(a.data.get(64..72)?.try_into().ok()?))
    }

    fn sign(&self, mint: Pubkey, destination: Pubkey, amount: u64) -> Vec<u8> {
        let q = self.nonce();
        let action = Action::WithdrawToken { mint, destination, amount };
        signer::sign(&ID, q, &SEED, &action.message(&self.vault, q, &key(q + 1)), &[q as u8; lmots::N])
    }

    fn submit(&mut self, sig: Vec<u8>, mint: Pubkey, vault_tokens: Pubkey, destination: Pubkey, program: Pubkey, amount: u64) -> Result<(), String> {
        self.submit_meta(sig, mint, vault_tokens, destination, program, amount, true)
    }

    /// The program does not mark the destination `mut` (see `PqWithdrawToken`), so clients pass it writable.
    #[allow(clippy::too_many_arguments)]
    fn submit_meta(
        &mut self,
        sig: Vec<u8>,
        mint: Pubkey,
        vault_tokens: Pubkey,
        destination: Pubkey,
        program: Pubkey,
        amount: u64,
        writable: bool,
    ) -> Result<(), String> {
        let q = self.nonce();
        let mut metas =
            qanary_vault::accounts::PqWithdrawToken { vault: self.vault, mint, vault_tokens, destination, token_program: program }
                .to_account_metas(None);
        metas[3].is_writable = writable;
        let ix = Instruction::new_with_bytes(
            qanary_vault::id(),
            &qanary_vault::instruction::PqWithdrawToken { signature: sig, amount, next_key: key(q + 1) }.data(),
            metas,
        );
        let mut data = vec![2u8];
        data.extend_from_slice(&1_400_000u32.to_le_bytes());
        self.send(&[Instruction::new_with_bytes(COMPUTE_BUDGET, &data, vec![]), ix])
    }

    /// Signs with the current key and submits with the right accounts.
    fn withdraw(&mut self, program: Pubkey, mint: Pubkey, destination: Pubkey, amount: u64) -> Result<(), String> {
        let sig = self.sign(mint, destination, amount);
        let ata = self.ata(&mint, &program);
        self.submit(sig, mint, ata, destination, program, amount)
    }

    /// The request verified, consumed key 0, moved nothing and said why.
    fn assert_skipped(&self, mint: &Pubkey, program: &Pubkey, destination: &Pubkey, reason: u8) {
        assert_eq!(self.skipped(), Some(reason), "skip reason");
        assert_eq!(self.nonce(), 1, "key consumed");
        assert_eq!(self.amount(&self.ata(mint, program)), Some(VAULT_BALANCE), "vault untouched");
        assert_ne!(self.amount(destination), Some(400), "nothing arrived");
    }
}

#[test]
fn spl_token_and_token_2022_withdrawals_move_tokens_and_rotate_the_key() {
    for program in [TOKEN, TOKEN_2022] {
        let mut env = Env::new();
        let (mint, dest) = env.funded(program, Ext::default(), Ext::default());
        env.withdraw(program, mint, dest, 400).expect("withdraw");
        assert_eq!((env.amount(&dest), env.skipped()), (Some(400), None));
        assert_eq!(env.amount(&env.ata(&mint, &program)), Some(VAULT_BALANCE - 400));
        assert_eq!(env.nonce(), 1);
        env.withdraw(program, mint, dest, 100).expect("next key works");
        assert_eq!((env.amount(&dest), env.nonce()), (Some(500), 2));
    }
}

#[test]
fn a_destination_closed_or_for_another_mint_is_skipped() {
    let mut env = Env::new();
    let (mint, _) = env.funded(TOKEN, Ext::default(), Ext::default());
    let gone = Pubkey::new_unique();
    env.withdraw(TOKEN, mint, gone, 400).expect("closed destination skipped, not failed");
    env.assert_skipped(&mint, &TOKEN, &gone, skip::DESTINATION);

    let mut env = Env::new();
    let (mint, _) = env.funded(TOKEN, Ext::default(), Ext::default());
    let other_mint = env.mint(TOKEN, Ext::default());
    let wrong = Pubkey::new_unique();
    env.token_account(wrong, TOKEN, other_mint, Pubkey::new_unique(), 0, AccountState::Initialized, Ext::default());
    env.withdraw(TOKEN, mint, wrong, 400).expect("wrong-mint destination skipped, not failed");
    env.assert_skipped(&mint, &TOKEN, &wrong, skip::DESTINATION);
}

#[test]
fn frozen_accounts_and_impossible_amounts_are_skipped() {
    let mut env = Env::new();
    let (mint, _) = env.funded(TOKEN, Ext::default(), Ext::default());
    let frozen = Pubkey::new_unique();
    env.token_account(frozen, TOKEN, mint, Pubkey::new_unique(), 0, AccountState::Frozen, Ext::default());
    env.withdraw(TOKEN, mint, frozen, 400).expect("frozen destination skipped");
    env.assert_skipped(&mint, &TOKEN, &frozen, skip::DESTINATION);

    let mut env = Env::new();
    let (mint, dest) = env.funded(TOKEN, Ext::default(), Ext::default());
    let ata = env.ata(&mint, &TOKEN);
    let vault = env.vault;
    env.token_account(ata, TOKEN, mint, vault, VAULT_BALANCE, AccountState::Frozen, Ext::default());
    env.withdraw(TOKEN, mint, dest, 400).expect("frozen vault account skipped");
    assert_eq!((env.nonce(), env.amount(&dest), env.skipped()), (1, Some(0), Some(skip::VAULT_TOKENS)));

    let mut env = Env::new();
    let (mint, dest) = env.funded(TOKEN, Ext::default(), Ext::default());
    env.withdraw(TOKEN, mint, dest, VAULT_BALANCE + 1).expect("too much skipped");
    assert_eq!(env.skipped(), Some(skip::AMOUNT));
    env.withdraw(TOKEN, mint, dest, 0).expect("zero skipped");
    assert_eq!(env.skipped(), Some(skip::AMOUNT));
    assert_eq!((env.nonce(), env.amount(&dest)), (2, Some(0)));
}

#[test]
fn a_token_the_vault_does_not_hold_is_skipped() {
    let mut env = Env::new();
    let mint = env.mint(TOKEN, Ext::default());
    let dest = Pubkey::new_unique();
    env.token_account(dest, TOKEN, mint, Pubkey::new_unique(), 0, AccountState::Initialized, Ext::default());
    env.withdraw(TOKEN, mint, dest, 400).expect("no vault token account: skipped");
    assert_eq!((env.nonce(), env.amount(&dest), env.skipped()), (1, Some(0), Some(skip::VAULT_TOKENS)));
}

#[test]
fn mints_and_destinations_that_can_never_take_the_transfer_are_skipped() {
    let cases = [
        (Ext { non_transferable: true, ..Ext::default() }, Ext::default(), skip::MINT, "non-transferable mint"),
        (Ext { paused: true, ..Ext::default() }, Ext::default(), skip::MINT, "paused mint"),
        (Ext { hook: true, ..Ext::default() }, Ext::default(), skip::MINT, "transfer hook"),
        (Ext::default(), Ext { memo_required: true, ..Ext::default() }, skip::DESTINATION, "memo required"),
        (Ext::default(), Ext { confidential_only: true, ..Ext::default() }, skip::DESTINATION, "confidential credits only"),
    ];
    for (mint_ext, dest_ext, reason, case) in cases {
        let mut env = Env::new();
        let (mint, dest) = env.funded(TOKEN_2022, mint_ext, dest_ext);
        env.withdraw(TOKEN_2022, mint, dest, 400).unwrap_or_else(|e| panic!("{case}: {e}"));
        env.assert_skipped(&mint, &TOKEN_2022, &dest, reason);
    }
}

#[test]
fn accounts_the_signature_does_not_fix_fail_before_the_key_and_a_corrected_resend_works() {
    let mut env = Env::new();
    let (mint, dest) = env.funded(TOKEN_2022, Ext::default(), Ext::default());
    let sig = env.sign(mint, dest, 400);
    let ata = env.ata(&mint, &TOKEN_2022);

    // Anyone can open an empty token account for the vault; passing it must not burn the key.
    let decoy = Pubkey::new_unique();
    let vault = env.vault;
    env.token_account(decoy, TOKEN_2022, mint, vault, 0, AccountState::Initialized, Ext::default());
    assert!(env.submit(sig.clone(), mint, decoy, dest, TOKEN_2022, 400).is_err(), "decoy vault account");
    // The other token program.
    let wrong_ata = env.ata(&mint, &TOKEN);
    assert!(env.submit(sig.clone(), mint, wrong_ata, dest, TOKEN, 400).is_err(), "wrong token program");
    assert_eq!(env.nonce(), 0, "key untouched");

    env.submit(sig, mint, ata, dest, TOKEN_2022, 400).expect("same signed bytes, right accounts");
    assert_eq!((env.nonce(), env.amount(&dest)), (1, Some(400)));
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

#[test]
fn destinations_the_runtime_never_credits_are_skipped() {
    let mut env = Env::new();
    let (mint, _) = env.funded(TOKEN, Ext::default(), Ext::default());
    let clock = anchor_lang::pubkey!("SysvarC1ock11111111111111111111111111111111");
    for (i, dest) in [clock, qanary_vault::id(), system_program::ID].iter().enumerate() {
        env.withdraw(TOKEN, mint, *dest, 400).unwrap_or_else(|e| panic!("{dest} skipped, not failed: {e}"));
        assert_eq!((env.nonce(), env.skipped()), (i as u32 + 1, Some(skip::DESTINATION)), "{dest}");
    }
    assert_eq!(env.amount(&env.ata(&mint, &TOKEN)), Some(VAULT_BALANCE));
}

#[test]
fn a_read_only_token_destination_fails_before_the_key_and_a_writable_resend_works() {
    let mut env = Env::new();
    let (mint, dest) = env.funded(TOKEN, Ext::default(), Ext::default());
    let sig = env.sign(mint, dest, 400);
    let ata = env.ata(&mint, &TOKEN);
    assert!(env.submit_meta(sig.clone(), mint, ata, dest, TOKEN, 400, false).is_err());
    assert_eq!(env.nonce(), 0);
    env.submit(sig, mint, ata, dest, TOKEN, 400).expect("same signed bytes, writable");
    assert_eq!((env.nonce(), env.amount(&dest)), (1, Some(400)));
}

#[test]
fn a_mint_that_never_existed_or_was_closed_is_skipped_with_either_token_program() {
    for program in [TOKEN, TOKEN_2022] {
        let mut env = Env::new();
        let ghost = Pubkey::new_unique();
        let dest = Pubkey::new_unique();
        env.withdraw(program, ghost, dest, 400).expect("missing mint skipped, not failed");
        assert_eq!((env.nonce(), env.skipped()), (1, Some(skip::MINT)));
    }

    // A Token-2022 mint closed at zero supply belongs to the System program afterwards.
    let mut env = Env::new();
    let (mint, dest) = env.funded(TOKEN_2022, Ext::default(), Ext::default());
    let ata = env.ata(&mint, &TOKEN_2022);
    let vault = env.vault;
    env.token_account(ata, TOKEN_2022, mint, vault, 0, AccountState::Initialized, Ext::default());
    env.svm.set_account(mint, Account { lamports: 0, data: vec![], owner: system_program::ID, executable: false, rent_epoch: 0 }).unwrap();
    env.withdraw(TOKEN_2022, mint, dest, 400).expect("closed mint skipped, not failed");
    assert_eq!((env.nonce(), env.skipped()), (1, Some(skip::MINT)));
    // Either token program gives the same answer, so a submitter cannot pick one that fails.
    let mut env = Env::new();
    let (mint, dest) = env.funded(TOKEN_2022, Ext::default(), Ext::default());
    env.svm.set_account(mint, Account { lamports: 0, data: vec![], owner: system_program::ID, executable: false, rent_epoch: 0 }).unwrap();
    env.withdraw(TOKEN, mint, dest, 400).expect("closed mint, other program: skipped");
    assert_eq!((env.nonce(), env.skipped()), (1, Some(skip::MINT)));
}
