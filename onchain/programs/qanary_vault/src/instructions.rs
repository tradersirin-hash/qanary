pub mod classic;
pub mod create_vault;
pub mod pq;

pub use classic::*;
pub use create_vault::*;
pub use pq::*;

use anchor_lang::prelude::*;

use crate::{error::VaultError, state::Vault};

/// Lamports the vault can pay out while staying rent-exempt.
pub(crate) fn spendable_sol(vault: &Account<Vault>) -> Result<u64> {
    let floor = Rent::get()?.minimum_balance(8 + Vault::INIT_SPACE);
    Ok(vault.get_lamports().saturating_sub(floor))
}

/// True if crediting `amount` would leave a brand-new `to` account below the rent-exempt minimum,
/// which the runtime rejects at the end of the transaction.
pub(crate) fn below_rent_for_new_account(to: &AccountInfo, amount: u64) -> Result<bool> {
    Ok(to.lamports() == 0 && to.data_is_empty() && amount < Rent::get()?.minimum_balance(0))
}

/// Moves lamports out of the vault PDA. Callers check `amount` against `spendable_sol` first.
pub(crate) fn move_sol<'info>(vault: &Account<'info, Vault>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    vault.sub_lamports(amount)?;
    to.add_lamports(amount)?;
    Ok(())
}

/// Classical path: fails loudly on a bad amount (no one-time key is at stake).
pub(crate) fn send_sol_checked<'info>(vault: &Account<'info, Vault>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    require!(amount <= spendable_sol(vault)?, VaultError::InsufficientFunds);
    move_sol(vault, to, amount)
}
