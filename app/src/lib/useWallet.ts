import { useCallback, useEffect, useState } from 'react';
import { connect, disconnect, watchWallets, type StandardWallet, type WalletAccount } from './wallet';

export type WalletState = {
  wallets: StandardWallet[];
  wallet: StandardWallet | null;
  account: WalletAccount | null;
  connectTo: (w: StandardWallet) => Promise<void>;
  disconnectNow: () => Promise<void>;
};

export function useWallet(): WalletState {
  const [wallets, setWallets] = useState<StandardWallet[]>([]);
  const [wallet, setWallet] = useState<StandardWallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);

  useEffect(() => watchWallets(setWallets), []);

  const connectTo = useCallback(async (w: StandardWallet) => {
    const acc = await connect(w);
    setWallet(w);
    setAccount(acc);
  }, []);

  const disconnectNow = useCallback(async () => {
    if (wallet) await disconnect(wallet).catch(() => undefined);
    setWallet(null);
    setAccount(null);
  }, [wallet]);

  return { wallets, wallet, account, connectTo, disconnectNow };
}
