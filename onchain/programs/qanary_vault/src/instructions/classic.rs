//! Classical convenience paths: signed by the vault's Ed25519 owner, and only while the quantum
//! canary in Qanary Bounty is alive. Once it trips, these paths close for good. Until then they are
//! exactly as safe as the owner's Ed25519 key: an attacker who breaks that key need not trip the canary.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use qanary_bounty::{state::Canary, CANARY_SEED};

use crate::{
    constants::*,
    error::VaultError,
    state::{Vault, Withdrawn},
};

fn require_classic(vault: &Vault, owner: &Pubkey, canary: &Canary) -> Result<()> {
    require!(!canary.tripped, VaultError::CanaryTripped);
    let expected = vault.owner.ok_or(VaultError::NoClassicalOwner)?;
    require_keys_eq!(expected, *owner, VaultError::NotOwner);
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.id.as_ref(), vault.genesis_key.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
    /// CHECK: any account may receive SOL; the owner's signature covers it.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    #[account(seeds = [CANARY_SEED], bump = canary.bump, seeds::program = qanary_bounty::ID)]
    pub canary: Account<'info, Canary>,
}

pub fn handle_withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
    require_classic(&ctx.accounts.vault, &ctx.accounts.owner.key(), &ctx.accounts.canary)?;
    super::send_sol_checked(&ctx.accounts.vault, &ctx.accounts.destination.to_account_info(), amount)?;
    emit!(Withdrawn {
        vault: ctx.accounts.vault.key(),
        mint: None,
        destination: ctx.accounts.destination.key(),
        amount,
        post_quantum: false,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawToken<'info> {
    #[account(seeds = [VAULT_SEED, vault.id.as_ref(), vault.genesis_key.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = vault, token::token_program = token_program)]
    pub vault_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [CANARY_SEED], bump = canary.bump, seeds::program = qanary_bounty::ID)]
    pub canary: Account<'info, Canary>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_withdraw_token(ctx: Context<WithdrawToken>, amount: u64) -> Result<()> {
    require_classic(&ctx.accounts.vault, &ctx.accounts.owner.key(), &ctx.accounts.canary)?;
    require!(amount > 0, VaultError::ZeroAmount);
    super::pq::transfer_tokens(
        &ctx.accounts.vault,
        &ctx.accounts.vault_tokens,
        &ctx.accounts.mint,
        &ctx.accounts.destination,
        &ctx.accounts.token_program,
        amount,
    )?;
    emit!(Withdrawn {
        vault: ctx.accounts.vault.key(),
        mint: Some(ctx.accounts.mint.key()),
        destination: ctx.accounts.destination.key(),
        amount,
        post_quantum: false,
    });
    Ok(())
}
