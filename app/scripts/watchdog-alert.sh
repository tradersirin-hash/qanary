# Opens an alert issue for a watchdog status other than "alive". Called by .github/workflows/watchdog.yml with
# CLUSTER, LABEL, STATUS, CANARY, BALANCE, BASELINE, TX, ERROR, SIGNED_TX, HISTORY, RUN and RUNBOOK (plus GH_TOKEN and
# GH_REPO) in the environment.
# Each cluster has its own label, so an open alert for one cluster never holds back a new one for the other. Within a
# cluster, an open alert holds back only a new one with the same status: a different status, such as tripped after
# drained, opens its own issue.
set -eo pipefail

TITLE="Canary watchdog ($CLUSTER): $STATUS"
export TITLE
gh label create "$LABEL" --color FFD23F --description "Canary watchdog alerts" --force
# A plain assignment, so that set -e fails the step when the list cannot be read: inside the test below, a failed
# list would read as an open issue and drop the alert.
open=$(gh issue list --label "$LABEL" --state open --json title --jq '[.[] | select(.title == env.TITLE)] | length')
if [ "$open" != "0" ]; then
  echo "An open issue titled \"$TITLE\" already exists, so no new one is opened."
  exit 0
fi
case "$STATUS" in
  tripped) summary="The $CLUSTER canary is tripped. Every $CLUSTER vault's classical path is closed." ;;
  drained) summary="The $CLUSTER honeypot fell below its baseline, but the watchdog could not trip the canary: $ERROR. Anyone can send check_honeypot: run app/scripts/watchdog.mjs with CLUSTER=$CLUSTER and a funded WATCHDOG_KEYPAIR." ;;
  signed) summary="The $CLUSTER canary key signed transaction $SIGNED_TX, so someone can sign with it: treat Ed25519 keys as broken. The honeypot is not below its baseline, so check_honeypot cannot trip the canary, and the program cannot take a signature as proof yet: the on-chain flag stays untripped." ;;
  history_gap) summary="The watchdog could not read every transaction that mentioned the $CLUSTER canary key in its lookback window ($HISTORY), so one the key signed could be hidden among them. The honeypot and the flag were checked as usual. Read the key's full history for that window by hand." ;;
  *) summary="The $CLUSTER canary account could not be read (status: $STATUS)." ;;
esac
body=$(printf '%s\n\n- Cluster: %s\n- Canary: %s\n- Honeypot: %s lamports (baseline %s)\n- Watchdog transaction: %s\n- Signed by the canary key: %s (%s)\n- Run: %s\n- Runbook: %s\n' \
  "$summary" "$CLUSTER" "$CANARY" "$BALANCE" "$BASELINE" "${TX:-none}" "${SIGNED_TX:-none found}" "${HISTORY:-history not read}" "$RUN" "$RUNBOOK")
gh issue create --label "$LABEL" --title "$TITLE" --body "$body"
