// One-time devnet setup: initialize the canary and seed the bounty pool and honeypot. With a test wallet address,
// it only sends that wallet some devnet SOL. Kept for this command line; scripts/canary-setup.mjs does the work.
//
//   node scripts/devnet-setup.mjs <deployer-keypair.json>
//   node scripts/devnet-setup.mjs <deployer-keypair.json> <test-wallet-address>
import { cli } from './canary-setup.mjs';

const [keyPath, testWallet] = process.argv.slice(2);
if (!keyPath) throw new Error('usage: node scripts/devnet-setup.mjs <deployer-keypair.json> [test-wallet-address]');
await cli(['--cluster', 'devnet', '--keypair', keyPath, ...(testWallet ? ['--test-wallet', testWallet] : [])]);
