//! Qanary Vault: SOL and SPL/Token-2022 custody behind hash-based post-quantum signatures.
//!
//! Each vault is controlled by a chain of one-time LM-OTS keys (RFC 8554, NIST SP 800-208 parameter
//! set LMOTS_SHA256_N24_W8). Every post-quantum action is signed by the current key and commits to
//! the next one, so the vault address stays fixed while keys never repeat.
//!
//! An optional Ed25519 owner (set by a post-quantum signature) can withdraw day to day, but only
//! while the quantum canary in Qanary Bounty is alive. Once it trips, only post-quantum signatures
//! can move funds. Before that, the owner path is only as safe as the owner's Ed25519 key.

pub mod constants;
pub mod error;
pub mod instructions;
pub mod lmots;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("DoYraMDno33DYCUytDMvdGWWcsNz1Qm983K15pHnzaqu");

/// Where to report vulnerabilities, embedded in the binary in the format of neodyme-labs/solana-security-txt
/// so explorers can show it. Left out of `no-entrypoint` builds: a program that links this one as a
/// dependency would otherwise carry a second copy and a duplicate symbol.
#[cfg(not(feature = "no-entrypoint"))]
#[cfg_attr(target_os = "solana", link_section = ".security.txt")]
#[allow(dead_code)]
#[no_mangle]
pub static SECURITY_TXT: &str = concat!(
    "=======BEGIN SECURITY.TXT V1=======\0",
    "name\0Qanary Vault\0",
    "project_url\0https://qanary.xyz\0",
    "contacts\0link:https://github.com/tradersirin-hash/qanary/security/advisories/new,link:https://x.com/Qanaryxyz\0",
    "policy\0https://github.com/tradersirin-hash/qanary/blob/main/SECURITY.md\0",
    "preferred_languages\0en\0",
    "source_code\0https://github.com/tradersirin-hash/qanary\0",
    "auditors\0None\0",
    "=======END SECURITY.TXT V1=======\0",
);

#[program]
pub mod qanary_vault {
    use super::*;

    pub fn create_vault(ctx: Context<CreateVault>, id: [u8; 16], key: [u8; 24]) -> Result<()> {
        crate::instructions::create_vault::handle_create_vault(ctx, id, key)
    }

    pub fn pq_withdraw_sol(ctx: Context<PqWithdrawSol>, signature: Vec<u8>, amount: u64, next_key: [u8; 24]) -> Result<()> {
        crate::instructions::pq::handle_pq_withdraw_sol(ctx, signature, amount, next_key)
    }

    pub fn pq_withdraw_token(ctx: Context<PqWithdrawToken>, signature: Vec<u8>, amount: u64, next_key: [u8; 24]) -> Result<()> {
        crate::instructions::pq::handle_pq_withdraw_token(ctx, signature, amount, next_key)
    }

    pub fn pq_set_owner(ctx: Context<PqSetOwner>, signature: Vec<u8>, owner: Option<Pubkey>, next_key: [u8; 24]) -> Result<()> {
        crate::instructions::pq::handle_pq_set_owner(ctx, signature, owner, next_key)
    }

    pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
        crate::instructions::classic::handle_withdraw_sol(ctx, amount)
    }

    pub fn withdraw_token(ctx: Context<WithdrawToken>, amount: u64) -> Result<()> {
        crate::instructions::classic::handle_withdraw_token(ctx, amount)
    }
}
