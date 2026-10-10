use anchor_lang::prelude::*;

use crate::{constants::*, error::VaultError, lmots};

/// A vault guarded by a chain of one-time LM-OTS keys. The vault address never changes; each
/// post-quantum action is signed by key `nonce` and commits to the key for `nonce + 1`.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// LM-OTS identifier `I` (`lmots::ID_LEN` bytes); first PDA seed.
    pub id: [u8; 16],
    /// Public key of one-time key 0; second PDA seed. Binding it into the address means whoever
    /// sends `create_vault` cannot attach a different key chain to this address.
    pub genesis_key: [u8; 24],
    /// Public key `K` (`lmots::N` bytes) of the one-time key for `nonce`.
    pub key: [u8; 24],
    /// Index `q` of the current one-time key.
    pub nonce: u32,
    /// Optional Ed25519 convenience signer, set only through a post-quantum signature. It can
    /// withdraw only while the quantum canary is alive, and is only as safe as its own key.
    pub owner: Option<Pubkey>,
    pub bump: u8,
}

/// What a post-quantum signature authorizes. The signed bytes bind the program, the vault, the
/// key index, the next key and every parameter, so nothing can be replayed or swapped.
pub enum Action {
    WithdrawSol { destination: Pubkey, amount: u64 },
    WithdrawToken { mint: Pubkey, destination: Pubkey, amount: u64 },
    SetOwner { owner: Option<Pubkey> },
}

impl Action {
    pub fn message(&self, vault: &Pubkey, nonce: u32, next_key: &[u8; 24]) -> Vec<u8> {
        let mut m = Vec::with_capacity(MESSAGE_DOMAIN.len() + 1 + 32 + 32 + 4 + lmots::N + 72);
        m.extend_from_slice(MESSAGE_DOMAIN);
        m.push(match self {
            Action::WithdrawSol { .. } => 1,
            Action::WithdrawToken { .. } => 2,
            Action::SetOwner { .. } => 3,
        });
        m.extend_from_slice(crate::ID.as_ref());
        m.extend_from_slice(vault.as_ref());
        m.extend_from_slice(&nonce.to_be_bytes());
        m.extend_from_slice(next_key);
        match self {
            Action::WithdrawSol { destination, amount } => {
                m.extend_from_slice(destination.as_ref());
                m.extend_from_slice(&amount.to_le_bytes());
            }
            Action::WithdrawToken { mint, destination, amount } => {
                m.extend_from_slice(mint.as_ref());
                m.extend_from_slice(destination.as_ref());
                m.extend_from_slice(&amount.to_le_bytes());
            }
            Action::SetOwner { owner } => match owner {
                Some(o) => {
                    m.push(1);
                    m.extend_from_slice(o.as_ref());
                }
                None => m.push(0),
            },
        }
        m
    }
}

impl Vault {
    /// Verifies a post-quantum signature for `action` and rotates to `next_key`.
    ///
    /// Callers must not fail after this returns for reasons the request itself causes (amount,
    /// balance, rent): a verified signature has to consume its one-time key, or the holder is left
    /// with a key they can neither use nor safely sign again.
    pub fn authorize(&mut self, vault: &Pubkey, signature: &[u8], next_key: [u8; 24], action: &Action) -> Result<()> {
        require!(signature.len() == lmots::SIG_LEN, VaultError::MalformedSignature);
        require!(next_key != self.key, VaultError::KeyReuse);
        let message = action.message(vault, self.nonce, &next_key);
        require!(lmots::verify(&self.id, self.nonce, &message, signature, &self.key), VaultError::InvalidSignature);

        self.key = next_key;
        self.nonce = self.nonce.checked_add(1).ok_or(VaultError::NonceExhausted)?;
        emit!(KeyRotated { vault: *vault, nonce: self.nonce });
        Ok(())
    }
}

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
}

#[event]
pub struct KeyRotated {
    pub vault: Pubkey,
    /// Index of the key that is now current.
    pub nonce: u32,
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    /// `None` for SOL.
    pub mint: Option<Pubkey>,
    pub destination: Pubkey,
    pub amount: u64,
    pub post_quantum: bool,
}

/// A verified post-quantum request that could not run (zero amount, not enough funds, rent, frozen
/// account). Its one-time key is still consumed, so the key chain stays usable.
#[event]
pub struct ActionSkipped {
    pub vault: Pubkey,
    /// Index of the key that is now current.
    pub nonce: u32,
    pub requested: u64,
    pub available: u64,
}
