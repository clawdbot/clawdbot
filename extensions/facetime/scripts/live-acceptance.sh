#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/live-acceptance.sh [--wait-seconds N]

Runs the Phase 1 FaceTime live acceptance sequence with a user present.
The script does not place FaceTime calls. It waits for an owner-handle incoming
call, checks internal routing stages, captures realtime status snapshots,
and hangs up only after an explicit prompt.
EOF
}

wait_seconds=180

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait-seconds)
      if [[ $# -lt 2 ]]; then
        echo "--wait-seconds requires a value" >&2
        usage >&2
        exit 2
      fi
      wait_seconds="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$wait_seconds" =~ ^[0-9]+$ ]] || [[ "$wait_seconds" -lt 1 ]]; then
  echo "--wait-seconds must be a positive integer" >&2
  exit 2
fi

log_dir="${TMPDIR:-/tmp}/openclaw-facetime-acceptance"
mkdir -p "$log_dir"
log_file="${log_dir}/$(date +%Y%m%d-%H%M%S).log"
exec > >(tee "$log_file") 2>&1

gateway_call() {
  openclaw gateway call "$@" --json --timeout 30000
}

read_status() {
  gateway_call facetime.status
}

require_preflight_ok() {
  # JavaScript template literals must reach Node unchanged.
  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const preflight = JSON.parse(fs.readFileSync(0, "utf8"));
    if (preflight && preflight.ok === true) {
      process.exit(0);
    }
    const failed = Array.isArray(preflight.checks)
      ? preflight.checks
          .filter((check) => check && check.required !== false && check.ok !== true)
          .map((check) => `${check.id || "unknown"}: ${check.message || "failed"}`)
      : [];
    console.error(`Preflight failed${failed.length ? `: ${failed.join("; ")}` : "."}`);
    process.exit(1);
  '
}

status_has_call() {
  node -e '
    const fs = require("node:fs");
    const status = JSON.parse(fs.readFileSync(0, "utf8"));
    process.exit(Array.isArray(status.calls) && status.calls.length > 0 ? 0 : 1);
  '
}

status_has_ready_paired_call() {
  node -e '
    const fs = require("node:fs");
    const status = JSON.parse(fs.readFileSync(0, "utf8"));
    const calls = Array.isArray(status.calls) ? status.calls : [];
    const ok = calls.some((call) => {
      const transport = call && typeof call === "object" ? call.audioTransport : undefined;
      return call.audioReady === true
        && call.realtimeActive === true
        && transport
        && transport.feedDevice === "OpenClaw-Feed"
        && transport.microphoneDevice === "OpenClaw-Mic"
        && transport.processInputVerified === true
        && transport.processOutputSuppressed === true;
    });
    process.exit(ok && status.processOutputSuppressed === true ? 0 : 1);
  '
}

status_bridge_is_idle() {
  node -e '
    const fs = require("node:fs");
    const status = JSON.parse(fs.readFileSync(0, "utf8"));
    const calls = Array.isArray(status.calls) ? status.calls : [];
    process.exit(calls.length === 0 && status.processOutputSuppressed === false ? 0 : 1);
  '
}

status_has_event_type() {
  local pattern="$1"
  node -e '
    const fs = require("node:fs");
    const pattern = new RegExp(process.argv[1]);
    const status = JSON.parse(fs.readFileSync(0, "utf8"));
    const calls = Array.isArray(status.calls) ? status.calls : [];
    const events = calls.flatMap((call) => Array.isArray(call.recentTalkEvents) ? call.recentTalkEvents : []);
    process.exit(events.some((event) => pattern.test(String(event.type || ""))) ? 0 : 1);
  ' "$pattern"
}

require_yes() {
  local prompt="$1"
  local answer
  read -r -p "$prompt [y/N] " answer
  case "$answer" in
    y|Y|yes|YES)
      ;;
    *)
      echo "Acceptance stopped: $prompt" >&2
      exit 1
      ;;
  esac
}

echo "Log: $log_file"
echo
echo "The native capture helper will verify OpenClaw-Mic against the actual call process before answer."

echo
echo "== Preflight =="
preflight_json="$(gateway_call facetime.preflight)"
printf '%s\n' "$preflight_json"
require_preflight_ok <<<"$preflight_json"

echo
echo "== Initial status =="
status_json="$(read_status)"
printf '%s\n' "$status_json"
if status_has_call <<<"$status_json"; then
  echo "Initial state is not clean: facetime.status already reports an active call." >&2
  exit 1
fi
if ! status_bridge_is_idle <<<"$status_json"; then
  echo "Initial state is not clean: the FaceTime bridge still owns physical-output mute." >&2
  exit 1
fi

echo
echo "== Initial bridge processes =="
pgrep -fl 'facetime-audio-capture|caffeinate -d -i -w' || true

echo
echo "Place the configured owner-handle FaceTime call from the iPhone now."
echo "Select OpenClaw-Mic as the FaceTime or Phone microphone if the app has not retained it."
echo "This script will wait up to ${wait_seconds}s for a paired-device realtime session."
deadline=$((SECONDS + wait_seconds))
call_seen=false
while true; do
  status_json="$(read_status)"
  if status_has_call <<<"$status_json"; then
    if [[ "$call_seen" == false ]]; then
      echo "FaceTime call detected; waiting for process capture and paired-device audio."
      call_seen=true
    fi
    if status_has_ready_paired_call <<<"$status_json"; then
      break
    fi
  fi
  if (( SECONDS >= deadline )); then
    if [[ "$call_seen" == true ]]; then
      echo "Timed out waiting for the active FaceTime call audio bridge." >&2
    else
      echo "Timed out waiting for an active FaceTime call." >&2
    fi
    printf '%s\n' "$status_json" >&2
    exit 1
  fi
  sleep 2
done

echo
echo "== Active call status =="
printf '%s\n' "$status_json"
echo "Internal stages are ready: process tap, native player, OpenClaw-Feed, OpenClaw-Mic, and local suppression."
require_yes "Did the iPhone hear an actual model response clearly?"

echo
echo "Speak into the iPhone and wait for the configured agent to respond, then press Enter."
read -r _
status_json="$(read_status)"
echo "== Realtime speech status =="
printf '%s\n' "$status_json"
if ! status_has_event_type 'transcript|output\.audio\.delta' <<<"$status_json"; then
  echo "Warning: recentTalkEvents did not show transcript or output.audio.delta in the current status window." >&2
fi
require_yes "Did the configured agent respond contextually to iPhone speech?"

echo
echo "Ask a tool-backed question now, then press Enter after the agent answers."
read -r _
status_json="$(read_status)"
echo "== Tool-use status =="
printf '%s\n' "$status_json"
if ! status_has_event_type 'tool\.(call|result)' <<<"$status_json"; then
  echo "Warning: recentTalkEvents did not show tool.call/tool.result in the current status window." >&2
fi
require_yes "Did the tool-backed answer complete correctly?"

echo
echo "Talk over the agent mid-sentence to test barge-in, then press Enter."
read -r _
status_json="$(read_status)"
echo "== Barge-in status =="
printf '%s\n' "$status_json"
require_yes "Did the agent stop speaking promptly when interrupted?"

echo
echo "The script can now hang up through OpenClaw."
read -r -p "Hang up the active FaceTime call through OpenClaw? [Y/n] " hangup_answer
case "$hangup_answer" in
  ""|y|Y|yes|YES)
    echo
    echo "== Hangup =="
    gateway_call facetime.hangup
    ;;
  *)
    echo "Hang up the FaceTime call from the iPhone, then press Enter."
    read -r _
    ;;
esac

sleep 2

echo
echo "== Final status =="
status_json="$(read_status)"
printf '%s\n' "$status_json"
if status_has_call <<<"$status_json"; then
  echo "Cleanup failed: facetime.status still reports an active call." >&2
  exit 1
fi
if ! status_bridge_is_idle <<<"$status_json"; then
  echo "Cleanup failed: the FaceTime bridge still owns physical-output mute." >&2
  exit 1
fi

echo
echo "== Final bridge processes =="
if pgrep -fl 'facetime-audio-capture|caffeinate -d -i -w'; then
  echo "Cleanup failed: FaceTime bridge processes are still running." >&2
  exit 1
fi

echo
echo "== Final running tasks =="
openclaw tasks list --status running

echo
echo "Acceptance log saved to $log_file"
