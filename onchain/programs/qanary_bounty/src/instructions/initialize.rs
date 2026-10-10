use anchor_lang::prelude::*;

use crate::{constants::*, state::Canary};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Canary::INIT_SPACE, seeds = [CANARY_SEED], bump)]
    pub canary: Account<'info, Canary>,
    /// CHECK: the honeypot address; only its lamport balance is read.
    #[account(address = CANARY_KEY)]
    pub honeypot: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Creates the global canary. Anyone may call it once; the resulting state is the same whoever does.
pub fn handle_initialize(ctx: Context<Initialize>) -> Result<()> {
    let canary = &mut ctx.accounts.canary;
    canary.tripped = false;
    canary.tripped_slot = 0;
    canary.claimer = Pubkey::default();
    canary.honeypot_baseline = ctx.accounts.honeypot.lamports();
    canary.total_funded = 0;
    canary.bump = ctx.bumps.canary;
    Ok(())
}
