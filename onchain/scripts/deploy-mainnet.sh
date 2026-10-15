#!/usr/bin/env bash
# Deploy the quantum canary (qanary_bounty) to mainnet-beta under the same program id as on devnet.
# Run scripts/wsl-build.sh first. The vault is unaudited: it is only deployed when named as an argument
# and QANARY_ALLOW_UNAUDITED_VAULT=1 is set.
#
# Dry run by default: prints each program id, binary size, whether the id is already on mainnet, the
# exact rent, a fee estimate and the payer's balance, checks that every link in the binaries' security.txt
# works, and sends nothing. Only --yes deploys, and only when the dry run would pass.
#
#   QANARY_MAINNET_PAYER=~/keys/mainnet-payer.json bash scripts/deploy-mainnet.sh         # dry run
#   QANARY_MAINNET_PAYER=~/keys/mainnet-payer.json bash scripts/deploy-mainnet.sh --yes   # deploy the bounty
#   QANARY_ALLOW_UNAUDITED_VAULT=1 QANARY_MAINNET_PAYER=... bash scripts/deploy-mainnet.sh qanary_vault
#
# QANARY_MAINNET_PAYER  keypair that pays and becomes the upgrade authority (required, never id.json)
# QANARY_MAINNET_RPC    RPC URL (default https://api.mainnet-beta.solana.com)
# QANARY_CU_PRICE       priority fee in micro-lamports per compute unit (default 50000)
# QANARY_UPGRADE_AUTHORITY  pubkey (e.g. a multisig vault) that takes over the upgrade authority after the deploy
# QANARY_USE_RPC=1      send the writes through the RPC instead of straight to the leaders
#
# An upload that fails or is interrupted stays in a buffer account; the same command resumes it.
# Never reads the Solana CLI config (--config /dev/null) and never falls back to ~/.config/solana/id.json.
set -euo pipefail
source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

SRC="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${QANARY_MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
CU_PRICE="${QANARY_CU_PRICE:-50000}"
NEW_AUTHORITY="${QANARY_UPGRADE_AUTHORITY:-}"
MAX_SIGN_ATTEMPTS=20
LAMPORTS_PER_SIGNATURE=5000
# Fee estimate: program bytes per write transaction (a little under what fits in 1232 bytes) and the
# default 200k compute-unit limit as an upper bound for the priority fee of each transaction.
CHUNK=950
CU_LIMIT_BOUND=200000
SYSTEM_PROGRAM=11111111111111111111111111111111
UPGRADEABLE_LOADER=BPFLoaderUpgradeab1e11111111111111111111111

die() { echo "error: $*" >&2; exit 1; }
sol_amount() { printf '%d.%09d SOL' $(($1 / 1000000000)) $(($1 % 1000000000)); }

yes=0
asked=" "
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    qanary_bounty | qanary_vault) asked+="$arg " ;;
    *) die "unknown argument '$arg' (expected --yes, qanary_bounty or qanary_vault)" ;;
  esac
done
[ "$asked" != " " ] || asked=" qanary_bounty "
if [[ "$asked" == *" qanary_vault "* ]] && [ "${QANARY_ALLOW_UNAUDITED_VAULT:-}" != 1 ]; then
  die "qanary_vault is unaudited and stays on devnet; set QANARY_ALLOW_UNAUDITED_VAULT=1 to deploy it anyway"
fi
# The canary goes first: the vault reads it.
programs=()
for program in qanary_bounty qanary_vault; do
  if [[ "$asked" == *" $program "* ]]; then programs+=("$program"); fi
done

PAYER="${QANARY_MAINNET_PAYER:-}"
[ -n "$PAYER" ] || die "set QANARY_MAINNET_PAYER to the payer keypair file; there is no default"
PAYER="${PAYER/#\~/$HOME}"
[ -f "$PAYER" ] || die "payer keypair $PAYER not found"
PAYER="$(realpath "$PAYER")"
DEFAULT_KEY="$HOME/.config/solana/id.json"
if [ "$PAYER" = "$(realpath -m "$DEFAULT_KEY")" ] || [ "$PAYER" -ef "$DEFAULT_KEY" ]; then
  die "refusing to use $DEFAULT_KEY; give a dedicated mainnet keypair"
fi
[[ "$CU_PRICE" =~ ^[0-9]+$ ]] || die "QANARY_CU_PRICE must be a whole number of micro-lamports"
if [ -n "$NEW_AUTHORITY" ] && ! [[ "$NEW_AUTHORITY" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
  die "QANARY_UPGRADE_AUTHORITY must be a base58 public key"
fi

sol() { solana --config /dev/null --url "$RPC" --keypair "$PAYER" --commitment confirmed "$@"; }
pubkey() { solana-keygen --config /dev/null pubkey "$1"; }
rent() {
  local lamports
  lamports=$(sol rent "$1" --lamports | awk '/Rent-exempt minimum/ {print $3}')
  [[ "$lamports" =~ ^[0-9]+$ ]] || die "could not read the rent for $1 bytes"
  echo "$lamports"
}
# The value of field $2 in the CLI's compact JSON output $1, without quotes.
json_field() {
  local re="\"$2\":\"?([^\",}]*)"
  if [[ "$1" =~ $re ]]; then echo "${BASH_REMATCH[1]}"; fi
}
# absent, program (an upgradeable program) or in-use (any other account, e.g. lamports sent to the address)
account_state() {
  local out
  if out=$(sol account "$1" --output json-compact 2>&1); then
    if [ "$(json_field "$out" owner)" = $UPGRADEABLE_LOADER ] && [ "$(json_field "$out" executable)" = true ]; then
      echo program
    else
      echo in-use
    fi
  elif [ "$out" = "Error: AccountNotFound: pubkey=$1" ]; then
    echo absent
  else
    die "could not read $1 from $RPC: $out"
  fi
}
# "authority length lamports" of the loader buffer $1, or nothing when it has no account.
buffer_info() {
  local out
  if out=$(sol program show "$1" --output json-compact 2>&1); then
    local info
    info="$(json_field "$out" authority) $(json_field "$out" dataLen) $(json_field "$out" lamports)"
    [ "$(json_field "$out" address)" = "$1" ] && [[ "$info" =~ ^[1-9A-HJ-NP-Za-km-z]+\ [0-9]+\ [0-9]+$ ]] ||
      die "$1 is not a buffer: $out"
    echo "$info"
  elif [ "$out" != "Error: Unable to find the account $1" ]; then
    die "could not read buffer $1 from $RPC: $out"
  fi
}
# The links in the security.txt of binary $1: project_url, policy, source_code and the link: contacts.
security_links() {
  local key value
  tr '\0' '\n' <"$1" |
    awk '/=======END SECURITY.TXT V1=======$/ { on = 0 } on { if (key == "") key = $0; else { print key " " $0; key = "" } } /=======BEGIN SECURITY.TXT V1=======$/ { on = 1 }' |
    while read -r key value; do
      case "$key" in
        project_url | policy | source_code) echo "$value" ;;
        contacts) tr ',' '\n' <<<"$value" | sed -n 's/^link://p' ;;
      esac
    done
}
# "ok", or why a link does not work.
check_link() {
  local repo out code
  if [[ "$1" =~ ^https://github\.com/([^/]+/[^/]+)/security/advisories/new$ ]]; then
    # Logged out, that page only redirects to a login, so ask the API whether private reporting is on.
    repo="${BASH_REMATCH[1]}"
    out=$(curl -sS --max-time 20 "https://api.github.com/repos/$repo/private-vulnerability-reporting" 2>&1) || true
    if [[ "$out" =~ \"enabled\":\ *true ]]; then
      echo ok
    elif [[ "$out" =~ \"enabled\":\ *false ]]; then
      echo "private vulnerability reporting is off for $repo (Settings > Code security)"
    else
      echo "could not ask the GitHub API about $repo"
    fi
  else
    code=$(curl -sS -o /dev/null -L --max-time 20 -w '%{http_code}' "$1" 2>/dev/null) || true
    case "$code" in
      200) echo ok ;;
      000 | "") echo "no answer" ;;
      *) echo "HTTP $code" ;;
    esac
  fi
}

declare -A ids=()
for program in qanary_bounty qanary_vault; do
  keypair="$SRC/target/deploy/$program-keypair.json"
  [ -f "$keypair" ] || die "$keypair not found"
  ids[$program]=$(pubkey "$keypair")
done
payer_key=$(pubkey "$PAYER")
balance=$(sol balance --lamports | awk '{print $1}')
[[ "$balance" =~ ^[0-9]+$ ]] || die "could not read the payer balance"
program_account_rent=$(rent 36)
# A transaction may not leave the payer with less than this, unless it empties it.
payer_rent=$(rent 0)

# The handover skips the new authority's signature and cannot be undone, so it must be a key that can sign.
if [ -n "$NEW_AUTHORITY" ]; then
  case "$NEW_AUTHORITY" in
    "$payer_key") die "QANARY_UPGRADE_AUTHORITY is the payer, which is the upgrade authority anyway; leave it unset" ;;
    "${ids[qanary_bounty]}" | "${ids[qanary_vault]}") die "QANARY_UPGRADE_AUTHORITY is a program id, which can never sign" ;;
    $SYSTEM_PROGRAM | 1nc1nerator11111111111111111111111111111111) die "nobody can sign for $NEW_AUTHORITY" ;;
  esac
  if out=$(sol account "$NEW_AUTHORITY" --output json-compact 2>&1); then
    owner=$(json_field "$out" owner)
    space=$(json_field "$out" space)
    # A wallet: a system account without data (a nonce account has data, and cannot sign either).
    if [ "$owner" != $SYSTEM_PROGRAM ] || [ "$(json_field "$out" executable)" != false ] || [ "$space" != 0 ]; then
      die "QANARY_UPGRADE_AUTHORITY $NEW_AUTHORITY is not a wallet (owner $owner, $space bytes of data); for a multisig give its vault address, not the multisig account"
    fi
    authority_note="a wallet holding $(sol_amount "$(json_field "$out" lamports)")"
  elif [ "$out" = "Error: AccountNotFound: pubkey=$NEW_AUTHORITY" ]; then
    authority_note="no account on mainnet yet"
  else
    die "QANARY_UPGRADE_AUTHORITY $NEW_AUTHORITY is not a public key: $out"
  fi
fi

if [ $yes = 1 ]; then echo "Qanary mainnet deploy"; else echo "Qanary mainnet deploy: DRY RUN, nothing is sent (pass --yes to deploy)"; fi
echo "  rpc:       $RPC"
echo "  payer:     $payer_key ($PAYER), balance $(sol_amount "$balance")"
echo "  authority: $payer_key${NEW_AUTHORITY:+, then handed to $NEW_AUTHORITY (${authority_note}); the handover cannot be undone}"
echo "  cu price:  $CU_PRICE micro-lamports per compute unit"

needed=$payer_rent
blocked=()
links=()
declare -A seen=()
for program in "${programs[@]}"; do
  so="$SRC/target/deploy/$program.so"
  id="${ids[$program]}"
  [ -f "$so" ] || die "$so not found; run scripts/wsl-build.sh"
  listed=$(awk -v p="$program" '{ sub(/\r$/, "") } /^\[/ { s = ($0 == "[programs.mainnet]") } s && $1 == p { gsub(/"/, "", $3); print $3 }' "$SRC/Anchor.toml")
  [ "$listed" = "$id" ] || die "$program: keypair id $id does not match [programs.mainnet] in Anchor.toml ($listed)"

  len=$(stat -c %s "$so")
  sbpf=$(od -An -tu1 -j48 -N1 "$so" | tr -d ' ')
  security_txt=$(grep -c -a "=======BEGIN SECURITY.TXT V1=======" "$so" || true)
  [ "$security_txt" = 1 ] || blocked+=("$so does not carry exactly one security.txt; rebuild it with scripts/wsl-build.sh")
  while read -r link; do
    if [ -n "$link" ] && [ -z "${seen[$link]:-}" ]; then seen[$link]=1; links+=("$link"); fi
  done < <(security_links "$so")
  program_data_rent=$(rent $((45 + len)))

  state=$(account_state "$id")
  case "$state" in
    absent) on_mainnet="not deployed yet" ;;
    program) on_mainnet="ALREADY DEPLOYED"; blocked+=("$program is already deployed at $id; this script only does first deploys") ;;
    *) on_mainnet="ADDRESS IN USE"; blocked+=("$id holds an account that is not a program, so the deploy would fail") ;;
  esac

  # A buffer keypair left by an earlier --yes run: the CLI resumes that upload. The buffer already holds
  # the program data rent, which the deploy hands back to the payer to fund the program data.
  buffer="$SRC/target/deploy/$program-mainnet-buffer.json"
  buffer_note=""
  info=""
  paid=0
  if [ -f "$buffer" ]; then
    buffer_key=$(pubkey "$buffer")
    info=$(buffer_info "$buffer_key")
    if [ -n "$info" ]; then
      read -r buffer_authority buffer_len paid <<<"$info"
      buffer_note="$buffer_key ($buffer) resumes, already holds $paid lamports"
      [ "$buffer_authority" = "$payer_key" ] ||
        blocked+=("buffer $buffer_key belongs to $buffer_authority, not the payer; resume with that payer, or close the buffer with it and delete $buffer")
      [ "$buffer_len" = "$len" ] ||
        blocked+=("buffer $buffer_key holds $buffer_len bytes, not $len; close it (solana program close $buffer_key --authority $PAYER --recipient $payer_key --url $RPC --keypair $PAYER --config /dev/null) and delete $buffer")
    elif [ "$state" = program ]; then
      buffer_note="$buffer_key ($buffer) has no account: left over from that deploy, delete it"
    else
      buffer_note="$buffer_key ($buffer) has no account yet: the upload starts over"
    fi
  fi
  writes=$(((len + CHUNK - 1) / CHUNK))
  # Write the buffer (payer) and deploy (payer + program); first create the buffer (payer + buffer) unless
  # it exists, and afterwards hand over the authority (payer).
  txs=$((writes + 1))
  signatures=$((writes + 2))
  if [ -z "$info" ]; then txs=$((txs + 1)); signatures=$((signatures + 2)); fi
  if [ -n "$NEW_AUTHORITY" ]; then txs=$((txs + 1)); signatures=$((signatures + 1)); fi
  fees=$((signatures * LAMPORTS_PER_SIGNATURE + txs * CU_PRICE * CU_LIMIT_BOUND / 1000000))
  cost=$((program_data_rent + program_account_rent + fees - paid))
  [ "$cost" -gt 0 ] || cost=0
  needed=$((needed + cost))

  echo "== $program"
  echo "  program id:  $id ($on_mainnet)"
  echo "  binary:      $so"
  echo "               $len bytes, SBPF v$sbpf, security.txt $([ "$security_txt" = 1 ] && echo present || echo MISSING), sha256 $(sha256sum "$so" | cut -d' ' -f1)"
  echo "  rent:        $program_data_rent lamports (program data, 45 + $len bytes) + $program_account_rent (program account, 36 bytes)"
  if [ -n "$buffer_note" ]; then echo "  buffer:      $buffer_note"; fi
  echo "  fees:        at most $fees lamports ($txs transactions, $signatures signatures)"
  echo "  cost:        $(sol_amount "$cost")"
done

# The links are compiled into the binaries, and the canary is meant to become immutable.
echo "== security.txt links"
for link in "${links[@]}"; do
  result=$(check_link "$link")
  echo "  $link: $result"
  [ "$result" = ok ] || blocked+=("the security.txt link $link does not work: $result")
done

echo "== total: $(sol_amount "$needed") needed (including $payer_rent lamports the payer keeps to stay rent-exempt), payer has $(sol_amount "$balance")"
if [ "$balance" -lt "$needed" ]; then
  blocked+=("the payer is $(sol_amount $((needed - balance))) short; fund $payer_key first")
fi
if [ ${#blocked[@]} -gt 0 ]; then
  printf 'cannot deploy: %s\n' "${blocked[@]}" >&2
  exit 1
fi
if [ $yes = 0 ]; then
  echo "Dry run only. Re-run with --yes to deploy."
  exit 0
fi

deploying=""
buffer=""
# After a failed or interrupted deploy, say what is on mainnet now and how to go on.
resume_help() {
  [ -n "$deploying" ] || return 0
  local id="${ids[$deploying]}" left=() program buffer_key state info
  for program in "${programs[@]}"; do
    if [ "$program" = "$deploying" ] || [ ${#left[@]} -gt 0 ]; then left+=("$program"); fi
  done
  buffer_key=$(pubkey "$buffer")
  state=$(account_state "$id" 2>/dev/null) || state=unknown
  if [ "$state" = program ]; then
    echo >&2
    echo "$deploying is deployed at $id after all: the error came after the deploy, which used up buffer $buffer_key." >&2
    echo "  Delete $buffer." >&2
    if [ -n "$NEW_AUTHORITY" ]; then
      echo "  Hand over the upgrade authority: solana program set-upgrade-authority $id --upgrade-authority $PAYER --new-upgrade-authority $NEW_AUTHORITY --skip-new-upgrade-authority-signer-check --url $RPC --keypair $PAYER --config /dev/null" >&2
    fi
    if [ ${#left[@]} -gt 1 ]; then
      echo "  Then deploy the rest: run the dry run again with only ${left[*]:1} as arguments, then add --yes." >&2
    fi
    return 0
  fi
  info=$(buffer_info "$buffer_key" 2>/dev/null) || info=unknown
  if [ -z "$info" ]; then
    cat >&2 <<EOF

$deploying was not deployed, and nothing was written: buffer $buffer_key has no account.
  Retry: run the dry run again with only ${left[*]} as arguments, then add --yes.
EOF
    return 0
  fi
  if [ "$state" = unknown ] || [ "$info" = unknown ]; then
    printf '\nCould not read %s to see what landed. If %s is deployed (solana program show %s --url %s --keypair %s --config /dev/null), delete %s; otherwise:\n' \
      "$RPC" "$id" "$id" "$RPC" "$PAYER" "$buffer" >&2
  else
    printf '\n%s was not deployed. What was written so far stays in buffer %s, with the rent the payer put in.\n' \
      "$deploying" "$buffer_key" >&2
  fi
  cat >&2 <<EOF
  Resume:  run the dry run again with only ${left[*]} as arguments, then add --yes. It reuses $buffer,
           counts the rent already in the buffer and only writes what is missing.
  Inspect: solana program show --buffers --buffer-authority $payer_key --url $RPC --keypair $PAYER --config /dev/null
  Give up: solana program close $buffer_key --authority $PAYER --recipient $payer_key --url $RPC --keypair $PAYER --config /dev/null
           refunds the buffer's rent; then delete $buffer.
EOF
}
trap resume_help EXIT

for program in "${programs[@]}"; do
  so="$SRC/target/deploy/$program.so"
  keypair="$SRC/target/deploy/$program-keypair.json"
  id="${ids[$program]}"
  # A buffer keypair on disk lets a failed or interrupted upload resume instead of starting over.
  buffer="$SRC/target/deploy/$program-mainnet-buffer.json"
  [ -f "$buffer" ] || solana-keygen --config /dev/null new --no-bip39-passphrase --silent -o "$buffer"
  args=(--program-id "$keypair" --upgrade-authority "$PAYER" --buffer "$buffer"
    --with-compute-unit-price "$CU_PRICE" --max-sign-attempts "$MAX_SIGN_ATTEMPTS")
  if [ "${QANARY_USE_RPC:-}" = 1 ]; then args+=(--use-rpc); fi

  echo "== deploying $program to $id"
  deploying="$program"
  sol program deploy "$so" "${args[@]}"
  deploying=""
  rm -f "$buffer"

  if [ -n "$NEW_AUTHORITY" ]; then
    sol program set-upgrade-authority "$id" --upgrade-authority "$PAYER" \
      --new-upgrade-authority "$NEW_AUTHORITY" --skip-new-upgrade-authority-signer-check ||
      die "$program is deployed but the authority is still $payer_key; retry: solana program set-upgrade-authority $id --upgrade-authority $PAYER --new-upgrade-authority $NEW_AUTHORITY --skip-new-upgrade-authority-signer-check --url $RPC --keypair $PAYER --config /dev/null"
  fi
  sol program show "$id"
done
echo "balance left: $(sol_amount "$(sol balance --lamports | awk '{print $1}')")"
