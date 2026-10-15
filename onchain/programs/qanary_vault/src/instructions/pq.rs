//! Post-quantum paths: authorized by an LM-OTS signature, available whether or not the canary has tripped.
//!
//! A verified signature must always consume its one-time key: a signature that is public while its key
//! is still current can only be finished by signing again, which would weaken the key. So:
//! - whatever the signed message fixes (destination, mint), or what other people or time can change
//!   (an account that is closed, frozen or paused), is checked only after the signature verifies, and a
//!   request that cannot run is skipped with `ActionSkipped` instead of failing;
//! - accounts the message does not fix (the token program, the vault's token account) are checked
//!   before it, so whoever submits the transaction cannot burn the key by passing the wrong ones. A
//!   corrected resend of the same signed bytes still goes through.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_2022::spl_token_2022::{
        extension::{
            confidential_transfer::ConfidentialTransferAccount, memo_transfer::memo_required,
            non_transferable::NonTransferable, pausable::PausableConfig, transfer_hook, BaseStateWithExtensions,
            StateWithExtensions,
        },
        state::{Account as TokenState, AccountState, Mint as MintState},
    },
    token_interface::{self, TokenInterface, TransferChecked},
};

use crate::{
    constants::*,
    error::VaultError,
    state::{skip, Action, ActionSkipped, Vault, Withdrawn},
};

/// Owner of every sysvar account.
const SYSVAR_OWNER: Pubkey = pubkey!("Sysvar1111111111111111111111111111111111111");

/// Keys the runtime never write-locks, whatever a transaction asks for (agave-reserved-account-keys;
/// all are active on mainnet and the list only grows). `tests/test_vault.rs` checks it against agave.
pub const RESERVED_KEYS: [Pubkey; 31] = [
    pubkey!("AddressLookupTab1e1111111111111111111111111"),
    pubkey!("BPFLoader2111111111111111111111111111111111"),
    pubkey!("BPFLoader1111111111111111111111111111111111"),
    pubkey!("BPFLoaderUpgradeab1e11111111111111111111111"),
    pubkey!("ComputeBudget111111111111111111111111111111"),
    pubkey!("Config1111111111111111111111111111111111111"),
    pubkey!("Ed25519SigVerify111111111111111111111111111"),
    pubkey!("Feature111111111111111111111111111111111111"),
    pubkey!("LoaderV411111111111111111111111111111111111"),
    pubkey!("KeccakSecp256k11111111111111111111111111111"),
    pubkey!("Secp256r1SigVerify1111111111111111111111111"),
    pubkey!("StakeConfig11111111111111111111111111111111"),
    pubkey!("Stake11111111111111111111111111111111111111"),
    pubkey!("11111111111111111111111111111111"),
    pubkey!("Vote111111111111111111111111111111111111111"),
    pubkey!("ZkE1Gama1Proof11111111111111111111111111111"),
    pubkey!("ZkTokenProof1111111111111111111111111111111"),
    pubkey!("SysvarC1ock11111111111111111111111111111111"),
    pubkey!("SysvarEpochRewards1111111111111111111111111"),
    pubkey!("SysvarEpochSchedu1e111111111111111111111111"),
    pubkey!("SysvarFees111111111111111111111111111111111"),
    pubkey!("Sysvar1nstructions1111111111111111111111111"),
    pubkey!("SysvarLastRestartS1ot1111111111111111111111"),
    pubkey!("SysvarRecentB1ockHashes11111111111111111111"),
    pubkey!("SysvarRent111111111111111111111111111111111"),
    pubkey!("SysvarRewards111111111111111111111111111111"),
    pubkey!("SysvarS1otHashes111111111111111111111111111"),
    pubkey!("SysvarS1otHistory11111111111111111111111111"),
    pubkey!("SysvarStakeHistory1111111111111111111111111"),
    pubkey!("NativeLoader1111111111111111111111111111111"),
    pubkey!("Sysvar1111111111111111111111111111111111111"),
];

/// True if the runtime can never credit `account`: a reserved key (its write lock is always
/// demoted), a program account, or a sysvar.
fn cannot_receive(account: &AccountInfo) -> bool {
    account.executable || *account.owner == SYSVAR_OWNER || RESERVED_KEYS.contains(account.key)
}

#[derive(Accounts)]
pub struct PqWithdrawSol<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.id.as_ref(), vault.genesis_key.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: any account may receive SOL; the signed message fixes which one. Pass it writable. It is
    /// not marked `mut` because the runtime makes reserved keys and programs read-only whatever the
    /// transaction asks for; such a destination is skipped after the signature verifies.
    pub destination: UncheckedAccount<'info>,
}

pub fn handle_pq_withdraw_sol(ctx: Context<PqWithdrawSol>, signature: Vec<u8>, amount: u64, next_key: [u8; 24]) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let destination = ctx.accounts.destination.to_account_info();
    let cannot_receive = cannot_receive(&destination);
    // Anything else must be passed writable; a read-only meta is the submitter's mistake, fixed by resending.
    require!(cannot_receive || destination.is_writable, VaultError::DestinationNotWritable);

    ctx.accounts
        .vault
        .authorize(&vault_key, &signature, next_key, &Action::WithdrawSol { destination: destination.key(), amount })?;

    let available = super::spendable_sol(&ctx.accounts.vault)?;
    let skipped = if cannot_receive {
        Some(skip::DESTINATION)
    } else if amount == 0 || amount > available {
        Some(skip::AMOUNT)
    } else if super::below_rent_for_new_account(&destination, amount)? {
        Some(skip::RENT)
    } else {
        None
    };
    if let Some(reason) = skipped {
        emit!(ActionSkipped { vault: vault_key, nonce: ctx.accounts.vault.nonce, requested: amount, available, reason });
        return Ok(());
    }
    super::move_sol(&ctx.accounts.vault, &destination, amount)?;
    emit!(Withdrawn { vault: vault_key, mint: None, destination: destination.key(), amount, post_quantum: true });
    Ok(())
}

#[derive(Accounts)]
pub struct PqWithdrawToken<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.id.as_ref(), vault.genesis_key.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: fixed by the signed message. While a token program owns it, that program must be passed
    /// (checked before the signature). A mint no token program owns (never created, or a Token-2022
    /// mint closed at zero supply) is skipped after the signature, like everything else about it.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: must be the vault's associated token account for `mint` (checked before the signature,
    /// so nobody can pass another token account they opened for the vault, empty, to burn the key).
    #[account(mut)]
    pub vault_tokens: UncheckedAccount<'info>,
    /// CHECK: fixed by the signed message; checked after the signature verifies. Pass it writable. It is
    /// not marked `mut` because the runtime makes reserved keys and programs read-only; such a destination
    /// is never a token account and is skipped after the signature verifies.
    pub destination: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Tokens move only out of the vault's associated token account. Mints with a transfer hook, the
/// NonTransferable extension or a paused Pausable config, and destinations that require memos or refuse
/// non-confidential credits, are skipped: the transfer could never succeed.
pub fn handle_pq_withdraw_token(ctx: Context<PqWithdrawToken>, signature: Vec<u8>, amount: u64, next_key: [u8; 24]) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let mint = ctx.accounts.mint.key();
    let destination = ctx.accounts.destination.key();
    let token_program = ctx.accounts.token_program.key();
    let mint_owner = *ctx.accounts.mint.owner;
    let live_mint = mint_owner == anchor_spl::token::ID || mint_owner == anchor_spl::token_2022::ID;
    require!(!live_mint || mint_owner == token_program, VaultError::TokenProgramMismatch);
    // Only a token account of `token_program` can be credited, and the runtime never demotes one; a
    // read-only meta for it is the submitter's mistake. Any other destination is skipped after the signature.
    require!(
        ctx.accounts.destination.is_writable || *ctx.accounts.destination.owner != token_program,
        VaultError::DestinationNotWritable
    );
    require_keys_eq!(
        ctx.accounts.vault_tokens.key(),
        get_associated_token_address_with_program_id(&vault_key, &mint, &token_program),
        VaultError::NotVaultTokenAccount
    );

    ctx.accounts
        .vault
        .authorize(&vault_key, &signature, next_key, &Action::WithdrawToken { mint, destination, amount })?;

    let decimals = match token_transfer_check(&ctx.accounts, amount) {
        Ok(decimals) => decimals,
        Err((available, reason)) => {
            emit!(ActionSkipped { vault: vault_key, nonce: ctx.accounts.vault.nonce, requested: amount, available, reason });
            return Ok(());
        }
    };
    transfer_tokens(
        &ctx.accounts.vault,
        ctx.accounts.vault_tokens.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.destination.to_account_info(),
        &ctx.accounts.token_program,
        amount,
        decimals,
    )?;
    emit!(Withdrawn { vault: vault_key, mint: Some(mint), destination, amount, post_quantum: true });
    Ok(())
}

/// The mint's decimals if `amount` can move from the vault's token account to `destination`;
/// otherwise the vault's balance and the [`skip`] reason to report in `ActionSkipped`.
fn token_transfer_check(a: &PqWithdrawToken, amount: u64) -> core::result::Result<u8, (u64, u8)> {
    let program = a.token_program.key();
    if *a.mint.owner != program {
        return Err((0, skip::MINT));
    }
    let from_data = a.vault_tokens.try_borrow_data().map_err(|_| (0, skip::VAULT_TOKENS))?;
    let from = StateWithExtensions::<TokenState>::unpack(&from_data).map_err(|_| (0, skip::VAULT_TOKENS))?;
    if *a.vault_tokens.owner != program || from.base.mint != a.mint.key() || from.base.owner != a.vault.key() {
        return Err((0, skip::VAULT_TOKENS));
    }
    let available = from.base.amount;
    if from.base.state != AccountState::Initialized {
        return Err((available, skip::VAULT_TOKENS));
    }
    if amount == 0 || amount > available {
        return Err((available, skip::AMOUNT));
    }

    let mint_data = a.mint.try_borrow_data().map_err(|_| (available, skip::MINT))?;
    let mint = StateWithExtensions::<MintState>::unpack(&mint_data).map_err(|_| (available, skip::MINT))?;
    let paused = mint.get_extension::<PausableConfig>().map(|p| bool::from(&p.paused)).unwrap_or(false);
    if paused || mint.get_extension::<NonTransferable>().is_ok() || transfer_hook::get_program_id(&mint).is_some() {
        return Err((available, skip::MINT));
    }

    let unusable = (available, skip::DESTINATION);
    if *a.destination.owner != program {
        return Err(unusable);
    }
    let to_data = a.destination.try_borrow_data().map_err(|_| unusable)?;
    let to = StateWithExtensions::<TokenState>::unpack(&to_data).map_err(|_| unusable)?;
    let refuses_plain_credits = to
        .get_extension::<ConfidentialTransferAccount>()
        .map(|c| !bool::from(&c.allow_non_confidential_credits))
        .unwrap_or(false);
    if to.base.mint != a.mint.key() || to.base.state != AccountState::Initialized || memo_required(&to) || refuses_plain_credits {
        return Err(unusable);
    }
    Ok(mint.base.decimals)
}

#[derive(Accounts)]
pub struct PqSetOwner<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.id.as_ref(), vault.genesis_key.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
}

/// Sets, replaces or removes the classical convenience owner.
pub fn handle_pq_set_owner(ctx: Context<PqSetOwner>, signature: Vec<u8>, owner: Option<Pubkey>, next_key: [u8; 24]) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let vault = &mut ctx.accounts.vault;
    vault.authorize(&vault_key, &signature, next_key, &Action::SetOwner { owner })?;
    vault.owner = owner;
    Ok(())
}

/// `transfer_checked` out of the vault's token account, signed by the vault PDA.
pub(crate) fn transfer_tokens<'info>(
    vault: &Account<'info, Vault>,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let bump = [vault.bump];
    let seeds: &[&[u8]] = &[VAULT_SEED, vault.id.as_ref(), vault.genesis_key.as_ref(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];
    let accounts = TransferChecked { from, mint, to, authority: vault.to_account_info() };
    token_interface::transfer_checked(CpiContext::new_with_signer(token_program.key(), accounts, signer), amount, decimals)
}
