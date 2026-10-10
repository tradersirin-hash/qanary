use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::BountyError,
    state::{BountyFunded, Canary},
};

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(mut, seeds = [CANARY_SEED], bump = canary.bump)]
    pub canary: Account<'info, Canary>,
    pub system_program: Program<'info, System>,
}

/// Adds SOL to the bounty pool. Nothing can withdraw it except a valid `claim`.
pub fn handle_fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
    require!(amount > 0, BountyError::ZeroAmount);
    require!(!ctx.accounts.canary.tripped, BountyError::AlreadyTripped);

    let cpi_accounts = anchor_lang::system_program::Transfer {
        from: ctx.accounts.funder.to_account_info(),
        to: ctx.accounts.canary.to_account_info(),
    };
    anchor_lang::system_program::transfer(CpiContext::new(anchor_lang::system_program::ID, cpi_accounts), amount)?;

    let canary = &mut ctx.accounts.canary;
    canary.total_funded = canary.total_funded.saturating_add(amount);
    emit!(BountyFunded { funder: ctx.accounts.funder.key(), amount, total_funded: canary.total_funded });
    Ok(())
}
