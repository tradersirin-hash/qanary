use anchor_lang::prelude::*;

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Prefix of every message a vault key signs, so a signature can never be valid for another protocol.
pub const MESSAGE_DOMAIN: &[u8] = b"qanary-vault-v1";
