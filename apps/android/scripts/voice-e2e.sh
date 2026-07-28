#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ANDROID_DIR="$ROOT_DIR/apps/android"
PACKAGE_NAME="ai.openclaw.app"
RECEIVER="$PACKAGE_NAME/.VoiceE2eReceiver"
RUN_ACTION="ai.openclaw.app.debug.RUN_VOICE_E2E"
OPEN_ACTION="ai.openclaw.app.debug.OPEN_VOICE_E2E"
PORT=18789
HOST="127.0.0.1"
MODE="both"
TRANSCRIPT="Reply exactly: Android voice e2e normal path ok."
REALTIME_ASSISTANT="Android realtime voice e2e relay path ok."
TIMEOUT_MS=60000
INSTALL=1
CONNECT=1
CLEANUP=0
START_GATEWAY=0

usage() {
  cat <<'USAGE'
Usage: apps/android/scripts/voice-e2e.sh [options]

Options:
  --mode connect|normal|realtime|both
                                  Gateway probe or voice path to test. Default: both.
  --transcript TEXT               Synthetic user transcript for the voice turn.
  --realtime-assistant TEXT       Synthetic realtime assistant relay text.
  --host HOST                     Gateway host visible from Android. Default: 127.0.0.1.
  --port PORT                     Gateway port. Default: 18789.
  --timeout-ms MS                 Per-mode timeout. Default: 60000.
  --skip-install                  Reuse the installed debug app.
  --no-connect                    Do not rewrite manual gateway settings.
  --start-gateway                 Start a temporary local gateway with bws_get_secret.
  --cleanup                       Stop voice capture after screenshots.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --transcript)
      TRANSCRIPT="$2"
      shift 2
      ;;
    --realtime-assistant)
      REALTIME_ASSISTANT="$2"
      shift 2
      ;;
    --host)
      HOST="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --timeout-ms)
      TIMEOUT_MS="$2"
      shift 2
      ;;
    --skip-install)
      INSTALL=0
      shift
      ;;
    --no-connect)
      CONNECT=0
      shift
      ;;
    --start-gateway)
      START_GATEWAY=1
      shift
      ;;
    --cleanup)
      CLEANUP=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="/opt/homebrew/opt/openjdk@17/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

ARTIFACT_DIR="/tmp/openclaw-android-voice-e2e-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$ARTIFACT_DIR"

cleanup_gateway() {
  if [[ -n "${GATEWAY_PID:-}" ]]; then
    kill "$GATEWAY_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup_gateway EXIT

if ! adb devices -l | awk 'NR > 1 && $2 == "device" { found = 1 } END { exit(found ? 0 : 1) }'; then
  echo "no authorized Android device found" >&2
  adb devices -l >&2
  exit 1
fi

adb reverse "tcp:$PORT" "tcp:$PORT" >/dev/null

if [[ "$START_GATEWAY" -eq 1 ]]; then
  if command -v bws_get_secret >/dev/null 2>&1; then
    OPENCLAW_OPENAI_API_KEY="$(bws_get_secret OPENCLAW_OPENAI_API_KEY)"
  else
    OPENCLAW_OPENAI_API_KEY="$(zsh -ic 'bws_get_secret OPENCLAW_OPENAI_API_KEY')"
  fi
  (
    cd "$ROOT_DIR"
    OPENAI_API_KEY="$OPENCLAW_OPENAI_API_KEY" \
      pnpm openclaw gateway run \
        --port "$PORT" \
        --auth none \
        --bind loopback \
        --force \
        --allow-unconfigured \
        --ws-log compact
  ) >"$ARTIFACT_DIR/gateway.log" 2>&1 &
  GATEWAY_PID=$!
  sleep 4
  if ! kill -0 "$GATEWAY_PID" >/dev/null 2>&1; then
    cat "$ARTIFACT_DIR/gateway.log" >&2
    exit 1
  fi
  unset OPENCLAW_OPENAI_API_KEY
fi

if [[ "$INSTALL" -eq 1 ]]; then
  (cd "$ANDROID_DIR" && ./gradlew :app:installPlayDebug)
fi

adb shell pm grant "$PACKAGE_NAME" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
adb shell am force-stop "$PACKAGE_NAME" >/dev/null
adb shell am start -a "$OPEN_ACTION" -n "$PACKAGE_NAME/.MainActivity" >/dev/null
adb logcat -c

run_mode() {
  local test_mode="$1"
  local result_name="$ARTIFACT_DIR/result-$test_mode.json"
  local screenshot_name="$ARTIFACT_DIR/screen-$test_mode.png"
  local transcript_base64
  local realtime_assistant_base64
  transcript_base64="$(printf '%s' "$TRANSCRIPT" | base64 | tr -d '\n')"
  realtime_assistant_base64="$(printf '%s' "$REALTIME_ASSISTANT" | base64 | tr -d '\n')"

  adb shell run-as "$PACKAGE_NAME" rm -f cache/voice_e2e_result.json >/dev/null 2>&1 || true
  local no_connect_flag=true
  if [[ "$CONNECT" -eq 1 ]]; then
    no_connect_flag=false
  fi

  adb shell run-as "$PACKAGE_NAME" am broadcast --user 0 \
    -a "$RUN_ACTION" \
    -n "$RECEIVER" \
    --es mode "$test_mode" \
    --ez noConnect "$no_connect_flag" \
    --es host "$HOST" \
    --ei port "$PORT" \
    --ez tls false \
    --el timeoutMs "$TIMEOUT_MS" \
    --el connectTimeoutMs "$TIMEOUT_MS" \
    --es transcriptBase64 "$transcript_base64" \
    --es realtimeAssistantBase64 "$realtime_assistant_base64" >/dev/null

  local deadline=$((SECONDS + TIMEOUT_MS / 1000 + 20))
  local result=""
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    result="$(adb shell run-as "$PACKAGE_NAME" cat cache/voice_e2e_result.json 2>/dev/null | tr -d '\r' || true)"
    if [[ -n "$result" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "$result" ]]; then
    echo "voice e2e $test_mode timed out waiting for result" >&2
    exit 1
  fi
  printf '%s\n' "$result" >"$result_name"
  adb exec-out screencap -p >"$screenshot_name"
  if ! grep -q '"ok":true' "$result_name"; then
    echo "voice e2e $test_mode failed: $result" >&2
    exit 1
  fi
}

case "$MODE" in
  both)
    run_mode normal
    run_mode realtime
    ;;
  normal|dictation)
    run_mode normal
    ;;
  realtime|talk)
    run_mode realtime
    ;;
  connect)
    run_mode connect
    ;;
  *)
    echo "unknown mode: $MODE" >&2
    exit 2
    ;;
esac

adb logcat -d -v time |
  rg -i 'OpenClaw|TalkMode|MicCapture|AudioRecord|SpeechRecognizer|realtime|talk.session|appendAudio|transcript|Talk failed|Transcription failed|Speech network|VoiceE2E' |
  tail -250 >"$ARTIFACT_DIR/logcat.txt" || true

if [[ "$CLEANUP" -eq 1 ]]; then
  adb shell run-as "$PACKAGE_NAME" am broadcast --user 0 -a "$RUN_ACTION" -n "$RECEIVER" --es mode stop >/dev/null
fi

echo "$ARTIFACT_DIR"
