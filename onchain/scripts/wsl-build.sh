#!/usr/bin/env bash
# Build and test the Anchor workspace on the WSL filesystem, which is far faster than building on /mnt/c.
# Sources stay in this folder; build output is mirrored back into ./target (deploy/, idl/, types/).
# Dependencies come only from the committed Cargo.lock: a stale lock, or a build that rewrites it, fails.
# CI (.github/workflows/ci.yml) builds the same .so files with cargo build-sbf and runs the same tests.
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
# anchor build takes no --locked, so fetch with it first: a lock that no longer matches Cargo.toml fails here.
cargo fetch --locked
anchor build
if [ "${1:-}" != "--no-test" ]; then
  cargo test --locked -- --nocapture
fi
# Nothing may have re-resolved the lock since (rsync put the committed one here); otherwise the .so files
# would come from a dependency graph that is not in the repo, so they are not copied back.
if ! cmp -s "$SRC/Cargo.lock" "$WORK/Cargo.lock"; then
  diff -u "$SRC/Cargo.lock" "$WORK/Cargo.lock" | head -n 40 >&2 || true
  echo "error: the build changed Cargo.lock; update and commit the lock in $SRC, then build again" >&2
  exit 1
fi

mkdir -p "$SRC/target/deploy" "$SRC/target/idl" "$SRC/target/types"
cp "$WORK"/target/deploy/*.so "$SRC/target/deploy/"
cp "$WORK"/target/idl/*.json "$SRC/target/idl/" 2>/dev/null || true
cp "$WORK"/target/types/*.ts "$SRC/target/types/" 2>/dev/null || true
ls -la "$SRC/target/deploy"
