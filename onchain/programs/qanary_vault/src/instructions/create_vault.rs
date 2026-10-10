use anchor_lang::prelude::*;

use crate::{
    constants::*,
    state::{Vault, VaultCreated},
};

#[derive(Accounts)]
#[instruction(id: [u8; 16], key: [u8; 24])]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, id.as_ref(), key.as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

/// Creates a vault whose first one-time key (index 0) has public key `key`. The address commits to
/// both `id` and `key`, and the vault starts with no classical owner, so a front-runner can at most
/// create exactly the vault the user asked for. A classical owner is added later with `pq_set_owner`.
pub fn handle_create_vault(ctx: Context<CreateVault>, id: [u8; 16], key: [u8; 24]) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.id = id;
    vault.genesis_key = key;
    vault.key = key;
    vault.nonce = 0;
    vault.owner = None;
    vault.bump = ctx.bumps.vault;
    emit!(VaultCreated { vault: vault.key() });
    Ok(())
}
