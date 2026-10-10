#!/usr/bin/env bash
# Deploy both programs to devnet with a dedicated devnet-only key. Run scripts/wsl-build.sh first.
# Never uses your default ~/.config/solana/id.json and never changes the Solana CLI config.
#
#   bash scripts/deploy-devnet.sh
set -euo pipefail
source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

KEY="${QANARY_DEPLOYER:-$HOME/.config/solana/qanary-devnet.json}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
URL=devnet

echo "deployer: $(solana-keygen pubkey "$KEY")  balance: $(solana balance --keypair "$KEY" --url $URL)"
for program in qanary_bounty qanary_vault; do
  echo "== $program ($(solana-keygen pubkey "$SRC/target/deploy/$program-keypair.json"))"
  solana program deploy "$SRC/target/deploy/$program.so" \
    --program-id "$SRC/target/deploy/$program-keypair.json" \
    --keypair "$KEY" --upgrade-authority "$KEY" --url $URL
done
echo "balance left: $(solana balance --keypair "$KEY" --url $URL)"
