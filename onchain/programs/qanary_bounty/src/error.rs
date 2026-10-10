use anchor_lang::prelude::*;

#[error_code]
pub enum BountyError {
    #[msg("The canary has already been tripped")]
    AlreadyTripped,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
}
