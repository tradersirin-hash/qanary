//! Post-quantum paths: authorized by an LM-OTS signature, available whether or not the canary has tripped.
//! Once a signature verifies, its one-time key is consumed even if the request cannot run.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    state::{Action, ActionSkipped, Vault, Withdrawn},
};

#[derive(Accounts)]
pub struct PqWithdrawSol<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.id.as_ref(), vault.genesis_key.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: any account may receive SOL; the signed message fixes which one.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

pub fn handle_pq_withdraw_sol(ctx: Context<PqWithdrawSol>, signature: Vec<u8>, amount: u64, next_key: [u8; 24]) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let destination = ctx.accounts.destination.to_account_info();
    ctx.accounts
        .vault
        .authorize(&vault_key, &signature, next_key, &Action::WithdrawSol { destination: destination.key(), amount })?;

    let available = super::spendable_sol(&ctx.accounts.vault)?;
    if amount == 0 || amount > available || super::below_rent_for_new_account(&destination, amount)? {
        emit!(ActionSkipped { vault: vault_key, nonce: ctx.accounts.vault.nonce, requested: amount, available });
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
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = vault, token::token_program = token_program)]
    pub vault_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Token-2022 mints with a transfer hook are not supported: the hook's extra accounts are not forwarded.
pub fn handle_pq_withdraw_token(ctx: Context<PqWithdrawToken>, signature: Vec<u8>, amount: u64, next_key: [u8; 24]) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let mint = ctx.accounts.mint.key();
    let destination = ctx.accounts.destination.key();
    ctx.accounts
        .vault
        .authorize(&vault_key, &signature, next_key, &Action::WithdrawToken { mint, destination, amount })?;

    let available = ctx.accounts.vault_tokens.amount;
    let frozen = ctx.accounts.vault_tokens.is_frozen() || ctx.accounts.destination.is_frozen();
    if amount == 0 || amount > available || frozen {
        emit!(ActionSkipped { vault: vault_key, nonce: ctx.accounts.vault.nonce, requested: amount, available });
        return Ok(());
    }
    transfer_tokens(
        &ctx.accounts.vault,
        &ctx.accounts.vault_tokens,
        &ctx.accounts.mint,
        &ctx.accounts.destination,
        &ctx.accounts.token_program,
        amount,
    )?;
    emit!(Withdrawn { vault: vault_key, mint: Some(mint), destination, amount, post_quantum: true });
    Ok(())
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
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let bump = [vault.bump];
    let seeds: &[&[u8]] = &[VAULT_SEED, vault.id.as_ref(), vault.genesis_key.as_ref(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];
    let accounts = TransferChecked {
        from: from.to_account_info(),
        mint: mint.to_account_info(),
        to: to.to_account_info(),
        authority: vault.to_account_info(),
    };
    token_interface::transfer_checked(
        CpiContext::new_with_signer(token_program.key(), accounts, signer),
        amount,
        mint.decimals,
    )
}
