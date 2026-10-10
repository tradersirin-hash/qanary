#!/usr/bin/env bash
# Build and test the Anchor workspace on the WSL filesystem, which is far faster than building on /mnt/c.
# Sources stay in this folder; build output is mirrored back into ./target (deploy/, idl/, types/).
#
#   bash scripts/wsl-build.sh          # anchor build + cargo test
#   bash scripts/wsl-build.sh --no-test
set -euo pipefail
source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${QANARY_WORK:-$HOME/qanary-onchain}"

mkdir -p "$WORK/target/deploy"
rsync -a --delete --exclude target --exclude node_modules --exclude test-ledger "$SRC/" "$WORK/"
# Program keypairs fix the program ids; they live with the sources.
cp -n "$SRC"/target/deploy/*-keypair.json "$WORK/target/deploy/" 2>/dev/null || true

cd "$WORK"
anchor build
if [ "${1:-}" != "--no-test" ]; then
  cargo test -- --nocapture
fi

mkdir -p "$SRC/target/deploy" "$SRC/target/idl" "$SRC/target/types"
cp "$WORK"/target/deploy/*.so "$SRC/target/deploy/"
cp "$WORK"/target/idl/*.json "$SRC/target/idl/" 2>/dev/null || true
cp "$WORK"/target/types/*.ts "$SRC/target/types/" 2>/dev/null || true
ls -la "$SRC/target/deploy"
