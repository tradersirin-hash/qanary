use anchor_lang::prelude::*;

use crate::{constants::*, state::Canary};

#[derive(Accounts)]
pub struct Claim<'info> {
    /// The proof: only someone who derived `CANARY_KEY`'s private key can sign for it.
    #[account(address = CANARY_KEY)]
    pub canary_key: Signer<'info>,
    /// CHECK: receives the pool. The claimer picks it, and the transaction signature binds it, so it cannot be swapped in flight.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    #[account(mut, seeds = [CANARY_SEED], bump = canary.bump)]
    pub canary: Account<'info, Canary>,
}

/// Pays the whole pool (everything above rent) to `recipient` and trips the canary.
pub fn handle_claim(ctx: Context<Claim>) -> Result<()> {
    let rent_floor = Rent::get()?.minimum_balance(8 + Canary::INIT_SPACE);
    let payout = ctx.accounts.canary.get_lamports().saturating_sub(rent_floor);
    if payout > 0 {
        ctx.accounts.canary.sub_lamports(payout)?;
        ctx.accounts.recipient.add_lamports(payout)?;
    }
    ctx.accounts.canary.trip(ctx.accounts.recipient.key(), true, payout)
}
