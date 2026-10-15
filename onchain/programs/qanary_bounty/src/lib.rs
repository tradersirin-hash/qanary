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

/// Where to report vulnerabilities, embedded in the binary in the format of neodyme-labs/solana-security-txt
/// so explorers can show it. Left out of `no-entrypoint` builds: a program that links this one as a
/// dependency would otherwise carry a second copy and a duplicate symbol.
#[cfg(not(feature = "no-entrypoint"))]
#[cfg_attr(target_os = "solana", link_section = ".security.txt")]
#[allow(dead_code)]
#[no_mangle]
pub static SECURITY_TXT: &str = concat!(
    "=======BEGIN SECURITY.TXT V1=======\0",
    "name\0Qanary Bounty\0",
    "project_url\0https://qanary.xyz\0",
    "contacts\0link:https://github.com/tradersirin-hash/qanary/security/advisories/new,link:https://x.com/Qanaryxyz\0",
    "policy\0https://github.com/tradersirin-hash/qanary/blob/main/SECURITY.md\0",
    "preferred_languages\0en\0",
    "source_code\0https://github.com/tradersirin-hash/qanary\0",
    "auditors\0None\0",
    "=======END SECURITY.TXT V1=======\0",
);

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
