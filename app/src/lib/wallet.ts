// Minimal Wallet Standard client (https://github.com/wallet-standard/wallet-standard): discovers
// injected wallets such as Phantom, Solflare and Backpack without extra dependencies.

export type WalletAccount = { address: string; publicKey: Uint8Array; chains: readonly string[]; features: readonly string[] };

type ConnectFeature = { connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }> };
type DisconnectFeature = { disconnect: () => Promise<void> };
type SignAndSendFeature = {
  signAndSendTransaction: (
    ...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]
  ) => Promise<readonly { signature: Uint8Array }[]>;
};

export type StandardWallet = {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly WalletAccount[];
  features: Record<string, unknown>;
};

export const CHAIN = 'solana:devnet';

function supportsSolana(w: StandardWallet): boolean {
  return w.chains.some((c) => c.startsWith('solana:')) && 'solana:signAndSendTransaction' in w.features && 'standard:connect' in w.features;
}

/** Calls `onChange` with every Solana wallet that registers, now or later. */
export function watchWallets(onChange: (wallets: StandardWallet[]) => void): () => void {
  const wallets: StandardWallet[] = [];
  const api = Object.freeze({
    register: (...registered: StandardWallet[]) => {
      for (const w of registered) if (supportsSolana(w) && !wallets.includes(w)) wallets.push(w);
      onChange([...wallets]);
      return () => {};
    },
  });
  const onRegister = (event: Event) => (event as CustomEvent<(a: typeof api) => void>).detail(api);
  window.addEventListener('wallet-standard:register-wallet', onRegister);
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  return () => window.removeEventListener('wallet-standard:register-wallet', onRegister);
}

export async function connect(wallet: StandardWallet): Promise<WalletAccount> {
  const { accounts } = await (wallet.features['standard:connect'] as ConnectFeature).connect();
  const account = accounts[0] ?? wallet.accounts[0];
  if (!account) throw new Error('The wallet returned no account');
  return account;
}

export async function disconnect(wallet: StandardWallet): Promise<void> {
  const feature = wallet.features['standard:disconnect'] as DisconnectFeature | undefined;
  await feature?.disconnect();
}

/** Asks the wallet to sign (as fee payer) and send a serialized transaction; returns the signature bytes. */
export async function signAndSend(wallet: StandardWallet, account: WalletAccount, transaction: Uint8Array): Promise<Uint8Array> {
  const [result] = await (wallet.features['solana:signAndSendTransaction'] as SignAndSendFeature).signAndSendTransaction({
    account,
    chain: CHAIN,
    transaction,
  });
  return result.signature;
}
