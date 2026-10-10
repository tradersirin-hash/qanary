use anchor_lang::prelude::*;

use crate::{constants::*, error::BountyError, state::Canary};

#[derive(Accounts)]
pub struct FundHoneypot<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    /// CHECK: the honeypot address (CANARY_KEY); receives the deposit.
    #[account(mut, address = CANARY_KEY)]
    pub honeypot: UncheckedAccount<'info>,
    #[account(mut, seeds = [CANARY_SEED], bump = canary.bump)]
    pub canary: Account<'info, Canary>,
    pub system_program: Program<'info, System>,
}

/// Adds SOL to the honeypot and records the new balance in the same instruction. A plain transfer
/// to CANARY_KEY is only watched once someone runs `check_honeypot`; this leaves no gap in which a
/// key-breaker could take the new deposit unnoticed. If the honeypot already dropped below its
/// baseline, the canary trips instead and no deposit is made.
pub fn handle_fund_honeypot(ctx: Context<FundHoneypot>, amount: u64) -> Result<()> {
    require!(amount > 0, BountyError::ZeroAmount);
    require!(!ctx.accounts.canary.tripped, BountyError::AlreadyTripped);

    if ctx.accounts.honeypot.lamports() < ctx.accounts.canary.honeypot_baseline {
        return ctx.accounts.canary.trip(Pubkey::default(), false, 0);
    }

    let cpi_accounts = anchor_lang::system_program::Transfer {
        from: ctx.accounts.funder.to_account_info(),
        to: ctx.accounts.honeypot.to_account_info(),
    };
    anchor_lang::system_program::transfer(CpiContext::new(anchor_lang::system_program::ID, cpi_accounts), amount)?;
    ctx.accounts.canary.honeypot_baseline = ctx.accounts.honeypot.lamports();
    Ok(())
}
