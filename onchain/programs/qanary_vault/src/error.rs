use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Post-quantum signature is malformed")]
    MalformedSignature,
    #[msg("Post-quantum signature does not match the vault's current key")]
    InvalidSignature,
    #[msg("The next key must differ from the current key")]
    KeyReuse,
    #[msg("The vault has used all of its one-time keys")]
    NonceExhausted,
    #[msg("Withdrawal would leave the vault below its rent-exempt minimum")]
    InsufficientFunds,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("This vault has no classical owner; use a post-quantum signature")]
    NoClassicalOwner,
    #[msg("Signer is not the vault's classical owner")]
    NotOwner,
    #[msg("The quantum canary has been tripped; only post-quantum signatures can move funds")]
    CanaryTripped,
}
