//! Qanary Bounty: an on-chain quantum canary for Solana.
//!
//! A pool of SOL sits behind `CANARY_KEY`, an Ed25519 public key nobody knows the private key of.
//! Signing for that key requires solving the elliptic-curve discrete log, which is what a large
//! quantum computer would do. The first valid claim takes the pool and permanently sets `tripped`,
//! a flag any program can read to switch itself into a post-quantum-only mode.
//!
//! The canary is a public, paid signal, not a detector: an attacker decides whether and when to
//! trip it. It cannot protect against the first attacker who goes straight for other keys.

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("HhrtGaEUk6Tar4cdCHkgTZj7jY5YXha4wjfdm8EteXRV");

#[program]
pub mod qanary_bounty {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx)
    }

    pub fn fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
        crate::instructions::fund::handle_fund(ctx, amount)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        crate::instructions::claim::handle_claim(ctx)
    }

    pub fn check_honeypot(ctx: Context<CheckHoneypot>) -> Result<()> {
        crate::instructions::check_honeypot::handle_check_honeypot(ctx)
    }

    pub fn fund_honeypot(ctx: Context<FundHoneypot>, amount: u64) -> Result<()> {
        crate::instructions::fund_honeypot::handle_fund_honeypot(ctx, amount)
    }
}
