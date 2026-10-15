# Opens an alert issue for a watchdog status other than "alive". Called by .github/workflows/watchdog.yml with
# CLUSTER, LABEL, STATUS, CANARY, BALANCE, BASELINE, TX, ERROR and RUN (plus GH_TOKEN and GH_REPO) in the environment.
# Each cluster has its own label, so an open alert for one cluster never holds back a new one for the other.
set -eo pipefail

gh label create "$LABEL" --color FFD23F --description "Canary watchdog alerts" --force
if [ "$(gh issue list --label "$LABEL" --state open --json number --jq length)" != "0" ]; then
  echo "An open $CLUSTER canary alert already exists."
  exit 0
fi
case "$STATUS" in
  tripped) summary="The $CLUSTER canary is tripped. Every $CLUSTER vault's classical path is closed." ;;
  drained) summary="The $CLUSTER honeypot fell below its baseline, but the watchdog could not trip the canary: $ERROR. Anyone can send check_honeypot: run app/scripts/watchdog.mjs with CLUSTER=$CLUSTER and a funded WATCHDOG_KEYPAIR." ;;
  *) summary="The $CLUSTER canary account could not be read (status: $STATUS)." ;;
esac
body=$(printf '%s\n\n- Cluster: %s\n- Canary: %s\n- Honeypot: %s lamports (baseline %s)\n- Watchdog transaction: %s\n- Run: %s\n' \
  "$summary" "$CLUSTER" "$CANARY" "$BALANCE" "$BASELINE" "${TX:-none}" "$RUN")
gh issue create --label "$LABEL" --title "Canary watchdog ($CLUSTER): $STATUS" --body "$body"
