#!/bin/bash
# Anthropic Spend Guardrail — the missing kill-switch equivalent to
# Forge's `.ralph-pause` for OpenClaw's always-on gateways.
#
# Root cause this guards against (Cost Watch, 2026-07-14+): two always-on
# OpenClaw gateways (Mac Mini + grey MacBook) ran Opus-tier models on every
# 30-min heartbeat with no spend cap and no kill switch. One key alone spent
# $347-$1,382/day for two weeks straight before anyone noticed, driven by
# continuous cache-read volume. This script closes that gap: it polls actual
# billed spend (not estimated) via the Anthropic Admin API, and if a
# configurable daily cap is exceeded, it STOPS THE GATEWAY — not just alerts.
#
# Install (once per machine, matching the auth-watchdog.sh pattern):
#   cp scripts/spend-guardrail.sh ~/.openclaw/tools/spend-guardrail.sh
#   chmod +x ~/.openclaw/tools/spend-guardrail.sh
#   crontab -e   # add:
#   */30 * * * * ANTHROPIC_ADMIN_KEY=sk-ant-admin-... SPEND_CAP_USD=100 ~/.openclaw/tools/spend-guardrail.sh >> /tmp/openclaw-spend-guardrail.log 2>&1
#
# Required env:
#   ANTHROPIC_ADMIN_KEY    - Admin API key (console.anthropic.com/settings/admin-keys),
#                            read-only "Usage & Cost" scope is sufficient.
# Optional env:
#   ANTHROPIC_API_KEY_IDS  - Comma-separated apikey_... ids to restrict the check to
#                            this gateway's own key(s). Omit to check org-wide spend
#                            (only safe if this gateway is the only thing using the org key).
#   SPEND_CAP_USD          - Daily USD cap before the kill switch trips (default: 100).
#   GATEWAY_LAUNCHD_LABEL  - launchd label to stop when tripped (default: ai.openclaw.gateway).
#   GATEWAY_LAUNCHD_DOMAIN - launchd domain (default: system; use gui/$(id -u) for a
#                            user LaunchAgent instead of a system LaunchDaemon).
#   NOTIFY_NTFY             - ntfy.sh topic for push notifications.
#   NOTIFY_SLACK_WEBHOOK    - Slack incoming webhook URL, if configured.
#   NOTIFY_SLACK_TOKEN      - Slack bot token (xoxb-...) for chat.postMessage,
#                            matching the pattern already used by monitor.sh.
#   NOTIFY_SLACK_CHANNEL    - Slack channel id to post to (default: #agents-dev's
#                            C0B5KNAV0TV, matching monitor.sh/auth-watchdog.sh).
#
# Reset after a trip (once the runaway cause is fixed) — the script's own
# alert message includes the exact command for this host, but as reference:
#   rm ~/.openclaw/SPEND-PAUSED
#   sudo launchctl bootstrap system /Library/LaunchDaemons/ai.openclaw.gateway.plist
#   # or, for a user LaunchAgent: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist

set -euo pipefail

SPEND_CAP_USD="${SPEND_CAP_USD:-100}"
GATEWAY_LAUNCHD_LABEL="${GATEWAY_LAUNCHD_LABEL:-ai.openclaw.gateway}"
GATEWAY_LAUNCHD_DOMAIN="${GATEWAY_LAUNCHD_DOMAIN:-system}"
# System LaunchDaemons live in /Library/LaunchDaemons and need sudo; user
# LaunchAgents (domain gui/$UID) live in ~/Library/LaunchAgents and don't.
if [ "$GATEWAY_LAUNCHD_DOMAIN" = "system" ]; then
  GATEWAY_PLIST_PATH="${GATEWAY_PLIST_PATH:-/Library/LaunchDaemons/${GATEWAY_LAUNCHD_LABEL}.plist}"
  SUDO="sudo"
else
  GATEWAY_PLIST_PATH="${GATEWAY_PLIST_PATH:-$HOME/Library/LaunchAgents/${GATEWAY_LAUNCHD_LABEL}.plist}"
  SUDO=""
fi
NOTIFY_NTFY="${NOTIFY_NTFY:-}"
NOTIFY_SLACK_WEBHOOK="${NOTIFY_SLACK_WEBHOOK:-}"
NOTIFY_SLACK_TOKEN="${NOTIFY_SLACK_TOKEN:-}"
NOTIFY_SLACK_CHANNEL="${NOTIFY_SLACK_CHANNEL:-C0B5KNAV0TV}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

# Reuse the gateway's own already-authorized Slack bot token (same pattern as
# auth-watchdog.sh) if no explicit token was passed via env — avoids needing
# to duplicate the secret into crontab just for this script. Some machines
# store `channels.slack.botToken` as a secrets-manager reference object
# (`{"source":"file",...}`) rather than a literal `xoxb-...` string — only
# use the derived value if it actually looks like a bot token.
if [ -z "$NOTIFY_SLACK_TOKEN" ] && [ -f "$OPENCLAW_CONFIG" ]; then
  DERIVED_TOKEN=$(python3 -c 'import json;print(json.load(open("'"$OPENCLAW_CONFIG"'"))["channels"]["slack"]["botToken"])' 2>/dev/null || echo "")
  case "$DERIVED_TOKEN" in
    xoxb-*) NOTIFY_SLACK_TOKEN="$DERIVED_TOKEN" ;;
    *) : ;; # not a literal token (e.g. secrets-manager reference) — leave unset, pass NOTIFY_SLACK_TOKEN explicitly via cron instead
  esac
fi
KILL_SWITCH_FILE="$HOME/.openclaw/SPEND-PAUSED"
STATE_FILE="$HOME/.openclaw/tools/.spend-guardrail-state.json"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"; }

send_alert() {
  local message="$1"
  local priority="${2:-high}"

  log "ALERT: $message"

  if [ -n "$NOTIFY_NTFY" ]; then
    curl -s -o /dev/null -m 10 \
      -H "Title: OpenClaw Spend Guardrail" \
      -H "Priority: $priority" \
      -H "Tags: warning,moneybag" \
      -d "$message" \
      "https://ntfy.sh/$NOTIFY_NTFY" || true
  fi

  if [ -n "$NOTIFY_SLACK_WEBHOOK" ]; then
    curl -s -o /dev/null -m 10 -X POST -H "Content-Type: application/json" \
      -d "$(jq -n --arg text "$message" '{text: $text}')" \
      "$NOTIFY_SLACK_WEBHOOK" || true
  fi

  if [ -n "$NOTIFY_SLACK_TOKEN" ]; then
    curl -s -o /dev/null -m 10 -X POST "https://slack.com/api/chat.postMessage" \
      -H "Authorization: Bearer $NOTIFY_SLACK_TOKEN" \
      -H "Content-Type: application/json; charset=utf-8" \
      -d "$(jq -n --arg channel "$NOTIFY_SLACK_CHANNEL" --arg text ":rotating_light: $message" '{channel: $channel, text: $text}')" || true
  fi
}

if [ -f "$KILL_SWITCH_FILE" ]; then
  log "Kill switch already tripped ($KILL_SWITCH_FILE exists) — gateway stays stopped. Not re-checking spend."
  log "To resume: rm $KILL_SWITCH_FILE && $SUDO launchctl bootstrap $GATEWAY_LAUNCHD_DOMAIN $GATEWAY_PLIST_PATH"
  exit 0
fi

if [ -z "${ANTHROPIC_ADMIN_KEY:-}" ]; then
  log "ANTHROPIC_ADMIN_KEY not set — cannot check spend. Skipping (fail open, not closed, to avoid killing the gateway on a config error)."
  exit 0
fi

# Since UTC midnight today, matching how Anthropic buckets daily cost.
STARTING_AT="$(date -u +%Y-%m-%dT00:00:00Z)"
ENDING_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

QUERY="starting_at=${STARTING_AT}&ending_at=${ENDING_AT}&bucket_width=1d&group_by[]=model"
if [ -n "${ANTHROPIC_API_KEY_IDS:-}" ]; then
  IFS=',' read -ra KEY_IDS <<< "$ANTHROPIC_API_KEY_IDS"
  for kid in "${KEY_IDS[@]}"; do
    QUERY="${QUERY}&api_key_ids[]=${kid}"
  done
fi

RESPONSE=$(curl -sf -m 20 "https://api.anthropic.com/v1/organizations/usage_report/messages?${QUERY}" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY") || {
  log "Admin API request failed — skipping this check (fail open)."
  exit 0
}

# Per-million-token pricing (USD), mirroring forge/src/lib/forge/claude-client.ts
# PRICING_PER_MTOK — keep both in sync with latest-llm-models.mdc.
TOTAL_COST_USD=$(echo "$RESPONSE" | jq '
  [.data[]?.results[]? | select(.model != null) | {
    model: .model,
    input: ((.uncached_input_tokens // 0) + (.cache_creation.ephemeral_5m_input_tokens // 0) + (.cache_creation.ephemeral_1h_input_tokens // 0)),
    cache_read: (.cache_read_input_tokens // 0),
    output: (.output_tokens // 0)
  }] | map(
    (if (.model | test("opus")) then {in: 5, out: 25, cache: 0.5}
     elif (.model | test("sonnet")) then {in: 3, out: 15, cache: 0.3}
     elif (.model | test("haiku")) then {in: 1, out: 5, cache: 0.1}
     else {in: 3, out: 15, cache: 0.3} end) as $p |
    (.input / 1000000 * $p.in) + (.cache_read / 1000000 * $p.cache) + (.output / 1000000 * $p.out)
  ) | add // 0
')

log "Spend since $STARTING_AT: \$$(printf '%.2f' "$TOTAL_COST_USD") (cap: \$${SPEND_CAP_USD})"
echo "{\"ts\":\"$(date -u +%FT%TZ)\",\"cost_usd\":$TOTAL_COST_USD,\"cap_usd\":$SPEND_CAP_USD}" > "$STATE_FILE"

if (( $(echo "$TOTAL_COST_USD >= $SPEND_CAP_USD" | bc -l) )); then
  MESSAGE="OpenClaw spend guardrail TRIPPED on $(hostname): \$$(printf '%.2f' "$TOTAL_COST_USD") spent today, cap is \$${SPEND_CAP_USD}. Stopping ${GATEWAY_LAUNCHD_LABEL} now. Resume with: rm $KILL_SWITCH_FILE && $SUDO launchctl bootstrap $GATEWAY_LAUNCHD_DOMAIN $GATEWAY_PLIST_PATH"

  mkdir -p "$(dirname "$KILL_SWITCH_FILE")"
  echo "$MESSAGE" > "$KILL_SWITCH_FILE"

  # The actual kill switch — bootout stops it AND prevents RunAtLoad from
  # restarting it on the next boot until an operator explicitly re-bootstraps.
  $SUDO launchctl bootout "$GATEWAY_LAUNCHD_DOMAIN/$GATEWAY_LAUNCHD_LABEL" 2>&1 || \
    log "launchctl bootout failed or already stopped — check manually."

  send_alert "$MESSAGE" "urgent"
  exit 1
else
  log "Under cap. No action taken."
fi
