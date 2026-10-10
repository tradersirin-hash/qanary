use anchor_lang::prelude::*;

/// The single global canary. Its `tripped` flag is the signal other programs (like Qanary Vault) read.
#[account]
#[derive(InitSpace)]
pub struct Canary {
    /// True once anyone proves control of `CANARY_KEY`. Never resets.
    pub tripped: bool,
    pub tripped_slot: u64,
    /// Where the pool was paid; the default pubkey until a claim.
    pub claimer: Pubkey,
    /// Lamports last seen at the `CANARY_KEY` address (the honeypot). Only its key can lower them.
    pub honeypot_baseline: u64,
    /// SOL contributed through `fund` over the canary's lifetime.
    pub total_funded: u64,
    pub bump: u8,
}

impl Canary {
    /// Marks the canary as tripped, keeping the first trip's record.
    pub fn trip(&mut self, claimer: Pubkey, by_claim: bool, payout: u64) -> Result<()> {
        if !self.tripped {
            self.tripped = true;
            self.tripped_slot = Clock::get()?.slot;
            self.claimer = claimer;
        }
        emit!(CanaryTripped { slot: self.tripped_slot, by_claim, claimer, payout });
        Ok(())
    }
}

#[event]
pub struct CanaryTripped {
    pub slot: u64,
    /// True when tripped by a claim signed with `CANARY_KEY`, false when tripped by a drained honeypot.
    pub by_claim: bool,
    pub claimer: Pubkey,
    pub payout: u64,
}

#[event]
pub struct BountyFunded {
    pub funder: Pubkey,
    pub amount: u64,
    pub total_funded: u64,
}
