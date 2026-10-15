import { describe, expect, it } from 'vitest';
import { clusterTag, deployment, t, tOn, type Key } from './copy';

// Every string that names a cluster, as the site showed it when both programs ran on devnet only.
const DEVNET: Partial<Record<Key, string>> = {
  liveCluster: 'Live · devnet',
  howVaultBody:
    'Keep devnet SOL behind LM-OTS hash-based signatures (RFC 8554, NIST SP 800-208). One 24-word phrase; a fresh one-time key signs each action in your browser, and your wallet only pays fees.',
  bridgeVaultLink: 'a vault behind post-quantum signatures, live on devnet',
  viewTx: 'View on Solana Explorer (devnet)',
  vaultStep2: 'Deposit devnet SOL from your wallet.',
  needWalletToCreate: "Connect a devnet wallet first. It pays the vault's rent and fees; it never holds the vault key.",
  confirmCreate: 'Create vault on devnet',
  noVaultFound: 'No vault exists for this phrase on devnet. Check the words, or create a new vault.',
  keyMismatch:
    'This phrase opens a vault whose current key does not match. Do not sign anything; check that you are on devnet and the words are in order.',
  vaultNotLoaded: 'The vault could not be read from devnet yet. Public RPC nodes can lag a few seconds behind.',
  connectFirst: 'Connect a devnet wallet first. It pays the network fees.',
  stepConfirm: 'Confirming on devnet',
  createdOk: 'Vault created on devnet. Next: deposit some devnet SOL.',
  canaryLoading: 'Reading the canary on devnet…',
  canaryRpcError: 'Could not reach devnet to read the canary. Retrying every 30 seconds.',
  canaryNotInitialized: 'The bounty program is live on devnet, but the canary has not been initialized yet.',
  canaryNotDeployed: 'The bounty program was not found on devnet.',
  canaryInitOk: 'Canary initialized on devnet.',
};

const SLOT = /\{(cluster|sol|wallet|tag)\}/;

describe('copy with both programs on devnet (the default)', () => {
  it('keeps every cluster sentence exactly as before', () => {
    for (const [key, text] of Object.entries(DEVNET)) expect(tOn('devnet', key as Key), key).toBe(text);
    expect(clusterTag('devnet')).toBe('Devnet');
  });

  it('keeps the sentences about both programs exactly as before', () => {
    expect(deployment('devnet', 'devnet')).toEqual({
      heroLive: 'Live: Scan on mainnet · Vault and Bounty on devnet',
      walletsTitle: 'Devnet wallets',
      walletsHint: 'Only needed for the devnet Vault and Bounty. Scanning works without a wallet.',
      howBountyBody:
        'A SOL bounty sits behind an Ed25519 key nobody holds. Claiming it flips a public flag; vaults read it and close their classical wallet path.',
      canarySectionSub:
        'A SOL bounty sits behind an Ed25519 key that nobody holds the private key for. Only someone who can break elliptic-curve keys can claim it, and claiming it flips a public flag that vaults, and any Solana program, can read.',
      vaultCanary: '',
      modelHonestBody:
        'Everything except Scan is planned, with no launch dates promised, and nothing here is for sale today. Anything that holds funds or switches on the canary (Vault Pro, canary integration) waits for an independent audit.',
      limit4:
        'Both programs run on devnet, are unaudited, and can still be upgraded by a classical (Ed25519) deployer key. Never use real funds.',
      programsTitle: 'Programs · devnet',
      footerBar: 'Unaudited research code · devnet only · never send real funds',
    });
  });
});

describe('copy on mainnet', () => {
  it('fills every slot and never says devnet', () => {
    for (const key of Object.keys(DEVNET) as Key[]) {
      const text = tOn('mainnet', key);
      expect(text, key).not.toMatch(SLOT);
      expect(text, key).not.toMatch(/devnet/i);
    }
    expect(tOn('mainnet', 'createdOk')).toBe('Vault created on mainnet. Next: deposit some SOL.');
    expect(tOn('mainnet', 'connectFirst')).toBe('Connect a wallet first. It pays the network fees.');
  });

  it('names where each program runs when the canary is on mainnet and the vault on devnet', () => {
    const d = deployment('mainnet', 'devnet');
    expect(d.heroLive).toBe('Live: Scan and Bounty on mainnet · Vault on devnet');
    expect(d.walletsHint).toBe('Only needed for the Vault (devnet) and the Bounty (mainnet). Scanning works without a wallet.');
    expect(d.limit4).toBe(
      'The Bounty runs on mainnet and the Vault on devnet only. Both are unaudited and can still be upgraded by a classical (Ed25519) deployer key. On mainnet, use only amounts you can afford to lose; on devnet, never use real funds.',
    );
    expect(d.programsTitle).toBe('Programs');
    expect(d.footerBar).toBe('Unaudited research code · Bounty on mainnet · Vault on devnet only · use only amounts you can afford to lose');
    expect(d.vaultCanary).toBe('This vault follows the canary on devnet, not the one on the Bounty page.');
    // The devnet vault does not read the mainnet canary, so no sentence may say vaults read the Bounty's flag.
    expect(d.howBountyBody).toBe(
      'A SOL bounty sits behind an Ed25519 key nobody holds. Claiming it flips a public flag that any program on mainnet can read. The Vault follows the canary on devnet.',
    );
    expect(d.canarySectionSub).toMatch(/a public flag that any program on mainnet can read\. Qanary Vault follows the canary on devnet\.$/);
    for (const text of [d.howBountyBody, d.canarySectionSub]) expect(text).not.toMatch(/vaults/);
    expect(d.modelHonestBody).not.toMatch(/holds funds/);
  });

  it('warns about real SOL on the mainnet Bounty and says which network to sign on', () => {
    expect(t('canaryMainnetBody')).toMatch(/^The bounty pool and the honeypot hold real mainnet SOL\. As deployed, the program has no withdraw/);
    expect(t('canaryMainnetBody')).toMatch(/until its upgrades are frozen, its deployer key could change the code that guards the pool/);
    expect(t('canaryMainnetBody')).toMatch(/Set your wallet's network to mainnet before you sign\.$/);
  });

  it('keeps devnet out of the vault banner when only the vault is on mainnet', () => {
    const d = deployment('devnet', 'mainnet');
    expect(d.vaultCanary).toBe('This vault follows the canary on mainnet, not the one on the Bounty page.');
    expect(`${t('mainnetBanner')} ${d.vaultCanary}`).not.toMatch(/devnet/i);
    expect(d.footerBar).toBe('Unaudited research code · Vault on mainnet · Bounty on devnet only · use only amounts you can afford to lose');
  });

  it('drops devnet wording entirely when both programs run on mainnet', () => {
    expect(deployment('mainnet', 'mainnet').vaultCanary).toBe('');
    for (const text of Object.values(deployment('mainnet', 'mainnet'))) {
      expect(text).not.toMatch(/devnet/i);
      expect(text).not.toMatch(SLOT);
    }
    expect(deployment('mainnet', 'mainnet').heroLive).toBe('Live: Scan, Vault and Bounty on mainnet');
    expect(deployment('devnet', 'mainnet').heroLive).toBe('Live: Scan and Vault on mainnet · Bounty on devnet');
  });

  it('fills every slot in every combination', () => {
    for (const canary of ['devnet', 'mainnet'] as const) {
      for (const vault of ['devnet', 'mainnet'] as const) {
        for (const [key, text] of Object.entries(deployment(canary, vault))) expect(text, `${canary}/${vault} ${key}`).not.toMatch(/\{\w+\}/);
      }
    }
  });
});
