use anchor_lang::prelude::*;

use crate::{constants::*, error::BountyError, state::Canary};

#[derive(Accounts)]
pub struct CheckHoneypot<'info> {
    /// CHECK: the honeypot address; only its lamport balance is read.
    #[account(address = CANARY_KEY)]
    pub honeypot: UncheckedAccount<'info>,
    #[account(mut, seeds = [CANARY_SEED], bump = canary.bump)]
    pub canary: Account<'info, Canary>,
}

/// Permissionless watchdog. Lamports at `CANARY_KEY` can only go down if its private key signed,
/// so a balance below the baseline trips the canary even if the attacker never claims the pool.
/// Otherwise the baseline rises to include any new honeypot deposits.
pub fn handle_check_honeypot(ctx: Context<CheckHoneypot>) -> Result<()> {
    require!(!ctx.accounts.canary.tripped, BountyError::AlreadyTripped);

    let current = ctx.accounts.honeypot.lamports();
    let canary = &mut ctx.accounts.canary;
    if current < canary.honeypot_baseline {
        return canary.trip(Pubkey::default(), false, 0);
    }
    canary.honeypot_baseline = current;
    Ok(())
}
