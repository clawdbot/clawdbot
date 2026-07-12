#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RESULTS_DIR="$ANDROID_DIR/benchmark/results"

PACKAGE="ai.openclaw.app"
ACTIVITY=".MainActivity"
DEVICE_SERIAL=""
INSTALL_APP="1"
LAUNCH_RUNS="4"
SCREEN_LOOPS="6"
CHAT_LOOPS="8"
POLL_ATTEMPTS="40"
POLL_INTERVAL_SECONDS="0.3"
SCREEN_MODE="transition"
CHAT_MODE="session-switch"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/perf-online-benchmark.sh [options]

Measures the fully-online Android app path on a connected device/emulator.
Assumes the app can reach a live gateway and will show "Connected" in the UI.

Options:
  --device <serial>          adb device serial
  --package <pkg>            package name (default: ai.openclaw.app)
  --activity <activity>      launch activity (default: .MainActivity)
  --skip-install             skip :app:installDebug
  --launch-runs <n>          launch-to-connected runs (default: 4)
  --screen-loops <n>         screen benchmark loops (default: 6)
  --chat-loops <n>           chat benchmark loops (default: 8)
  --screen-mode <mode>       transition | scroll (default: transition)
  --chat-mode <mode>         session-switch | scroll (default: session-switch)
  -h, --help                 show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      DEVICE_SERIAL="${2:-}"
      shift 2
      ;;
    --package)
      PACKAGE="${2:-}"
      shift 2
      ;;
    --activity)
      ACTIVITY="${2:-}"
      shift 2
      ;;
    --skip-install)
      INSTALL_APP="0"
      shift
      ;;
    --launch-runs)
      LAUNCH_RUNS="${2:-}"
      shift 2
      ;;
    --screen-loops)
      SCREEN_LOOPS="${2:-}"
      shift 2
      ;;
    --chat-loops)
      CHAT_LOOPS="${2:-}"
      shift 2
      ;;
    --screen-mode)
      SCREEN_MODE="${2:-}"
      shift 2
      ;;
    --chat-mode)
      CHAT_MODE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 required but missing." >&2
    exit 1
  fi
}

require_cmd adb
require_cmd awk
require_cmd rg
require_cmd node

adb_cmd() {
  if [[ -n "$DEVICE_SERIAL" ]]; then
    adb -s "$DEVICE_SERIAL" "$@"
  else
    adb "$@"
  fi
}

device_count="$(adb devices | awk 'NR>1 && $2=="device" {c+=1} END {print c+0}')"
if [[ -z "$DEVICE_SERIAL" && "$device_count" -lt 1 ]]; then
  echo "No connected Android device (adb state=device)." >&2
  exit 1
fi

if [[ -z "$DEVICE_SERIAL" && "$device_count" -gt 1 ]]; then
  echo "Multiple adb devices found. Pass --device <serial>." >&2
  adb devices -l >&2
  exit 1
fi

if [[ "$SCREEN_MODE" != "transition" && "$SCREEN_MODE" != "scroll" ]]; then
  echo "Unsupported --screen-mode: $SCREEN_MODE" >&2
  exit 2
fi

if [[ "$CHAT_MODE" != "session-switch" && "$CHAT_MODE" != "scroll" ]]; then
  echo "Unsupported --chat-mode: $CHAT_MODE" >&2
  exit 2
fi

mkdir -p "$RESULTS_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
run_dir="$RESULTS_DIR/online-$timestamp"
mkdir -p "$run_dir"

cleanup() {
  rm -f "$run_dir"/ui-*.xml
}
trap cleanup EXIT

if [[ "$INSTALL_APP" == "1" ]]; then
  (
    cd "$ANDROID_DIR"
    ./gradlew :app:installDebug --console=plain >"$run_dir/install.log" 2>&1
  )
fi

read -r display_width display_height <<<"$(
  adb_cmd shell wm size \
    | awk '/Physical size:/ { split($3, dims, "x"); print dims[1], dims[2]; exit }'
)"

if [[ -z "${display_width:-}" || -z "${display_height:-}" ]]; then
  echo "Failed to read device display size." >&2
  exit 1
fi

pct_of() {
  local total="$1"
  local pct="$2"
  awk -v total="$total" -v pct="$pct" 'BEGIN { printf "%d", total * pct }'
}

tab_chat_x="$(pct_of "$display_width" "0.31")"
tab_screen_x="$(pct_of "$display_width" "0.69")"
tab_y="$(pct_of "$display_height" "0.93")"
chat_session_y="$(pct_of "$display_height" "0.13")"
chat_session_left_x="$(pct_of "$display_width" "0.16")"
chat_session_right_x="$(pct_of "$display_width" "0.85")"
center_x="$(pct_of "$display_width" "0.50")"
screen_swipe_top_y="$(pct_of "$display_height" "0.27")"
screen_swipe_mid_y="$(pct_of "$display_height" "0.38")"
screen_swipe_low_y="$(pct_of "$display_height" "0.75")"
screen_swipe_bottom_y="$(pct_of "$display_height" "0.77")"
chat_swipe_top_y="$(pct_of "$display_height" "0.29")"
chat_swipe_mid_y="$(pct_of "$display_height" "0.38")"
chat_swipe_bottom_y="$(pct_of "$display_height" "0.71")"

dump_ui() {
  local name="$1"
  local file="$run_dir/ui-$name.xml"
  adb_cmd shell uiautomator dump "/sdcard/$name.xml" >/dev/null 2>&1
  adb_cmd shell cat "/sdcard/$name.xml" >"$file"
  printf '%s\n' "$file"
}

ui_has() {
  local pattern="$1"
  local name="$2"
  local file
  file="$(dump_ui "$name")"
  rg -q "$pattern" "$file"
}

wait_for_pattern() {
  local pattern="$1"
  local prefix="$2"
  for attempt in $(seq 1 "$POLL_ATTEMPTS"); do
    if ui_has "$pattern" "$prefix-$attempt"; then
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done
  return 1
}

ensure_connected() {
  if ! wait_for_pattern 'text="Connected"' "connected"; then
    echo "App never reached visible Connected state." >&2
    exit 1
  fi
}

ensure_screen_online() {
  adb_cmd shell input tap "$tab_screen_x" "$tab_y" >/dev/null
  sleep 2
  if ! ui_has 'android\.webkit\.WebView' "screen"; then
    echo "Screen benchmark expected a live WebView." >&2
    exit 1
  fi
}

ensure_chat_online() {
  adb_cmd shell input tap "$tab_chat_x" "$tab_y" >/dev/null
  sleep 2
  if ! ui_has 'Type a message' "chat"; then
    echo "Chat benchmark expected the live chat composer." >&2
    exit 1
  fi
}

capture_mem() {
  local file="$1"
  adb_cmd shell dumpsys meminfo "$PACKAGE" >"$file"
}

start_cpu_sampler() {
  local file="$1"
  local samples="$2"
  : >"$file"
  (
    for _ in $(seq 1 "$samples"); do
      adb_cmd shell top -b -n 1 \
        | awk -v pkg="$PACKAGE" '$NF==pkg { print $9 }' >>"$file"
      sleep 0.5
    done
  ) &
  CPU_SAMPLER_PID="$!"
}

summarize_cpu() {
  local file="$1"
  local prefix="$2"
  local avg max median count
  avg="$(awk '{sum+=$1; n++} END {if(n) printf "%.1f", sum/n; else print 0}' "$file")"
  max="$(sort -n "$file" | tail -n 1)"
  median="$(
    sort -n "$file" \
      | awk '{a[NR]=$1} END { if (NR==0) { print 0 } else if (NR%2==1) { printf "%.1f", a[(NR+1)/2] } else { printf "%.1f", (a[NR/2]+a[NR/2+1])/2 } }'
  )"
  count="$(wc -l <"$file" | tr -d ' ')"
  printf '%s.cpu_avg_pct=%s\n' "$prefix" "$avg" >>"$run_dir/summary.txt"
  printf '%s.cpu_median_pct=%s\n' "$prefix" "$median" >>"$run_dir/summary.txt"
  printf '%s.cpu_peak_pct=%s\n' "$prefix" "$max" >>"$run_dir/summary.txt"
  printf '%s.cpu_count=%s\n' "$prefix" "$count" >>"$run_dir/summary.txt"
}

summarize_mem() {
  local file="$1"
  local prefix="$2"
  awk -v prefix="$prefix" '
    /TOTAL PSS:/ { printf "%s.pss_kb=%s\n%s.rss_kb=%s\n", prefix, $3, prefix, $6 }
    /Graphics:/ { printf "%s.graphics_kb=%s\n", prefix, $2 }
    /WebViews:/ { printf "%s.webviews=%s\n", prefix, $NF }
  ' "$file" >>"$run_dir/summary.txt"
}

summarize_gfx() {
  local file="$1"
  local prefix="$2"
  awk -v prefix="$prefix" '
    /Total frames rendered:/ { printf "%s.frames=%s\n", prefix, $4 }
    /Janky frames:/ && $4 ~ /\(/ {
      pct=$4
      gsub(/[()%]/, "", pct)
      printf "%s.janky_frames=%s\n%s.janky_pct=%s\n", prefix, $3, prefix, pct
    }
    /50th percentile:/ { gsub(/ms/, "", $3); printf "%s.p50_ms=%s\n", prefix, $3 }
    /90th percentile:/ { gsub(/ms/, "", $3); printf "%s.p90_ms=%s\n", prefix, $3 }
    /95th percentile:/ { gsub(/ms/, "", $3); printf "%s.p95_ms=%s\n", prefix, $3 }
    /99th percentile:/ { gsub(/ms/, "", $3); printf "%s.p99_ms=%s\n", prefix, $3 }
  ' "$file" >>"$run_dir/summary.txt"
}

measure_launch() {
  : >"$run_dir/launch-runs.txt"
  for run in $(seq 1 "$LAUNCH_RUNS"); do
    adb_cmd shell am force-stop "$PACKAGE" >/dev/null
    sleep 1
    start_ms="$(node -e 'console.log(Date.now())')"
    am_out="$(adb_cmd shell am start -W -n "$PACKAGE/$ACTIVITY")"
    total_time="$(printf '%s\n' "$am_out" | awk -F: '/TotalTime:/{gsub(/ /, "", $2); print $2}')"
    connected_ms="timeout"
    for _ in $(seq 1 "$POLL_ATTEMPTS"); do
      if ui_has 'text="Connected"' "launch-run-$run"; then
        now_ms="$(node -e 'console.log(Date.now())')"
        connected_ms="$((now_ms - start_ms))"
        break
      fi
      sleep "$POLL_INTERVAL_SECONDS"
    done
    printf 'run=%s total_time_ms=%s connected_ms=%s\n' "$run" "${total_time:-na}" "$connected_ms" \
      | tee -a "$run_dir/launch-runs.txt"
  done

  awk -F'[ =]' '
    /total_time_ms=[0-9]+/ {
      value=$4
      sum+=value
      count+=1
      if (min==0 || value<min) min=value
      if (value>max) max=value
    }
    END {
      if (count==0) exit
      printf "launch.total_time_avg_ms=%.1f\nlaunch.total_time_min_ms=%d\nlaunch.total_time_max_ms=%d\n", sum/count, min, max
    }
  ' "$run_dir/launch-runs.txt" >>"$run_dir/summary.txt"

  awk -F'[ =]' '
    /connected_ms=[0-9]+/ {
      value=$6
      sum+=value
      count+=1
      if (min==0 || value<min) min=value
      if (value>max) max=value
    }
    END {
      if (count==0) exit
      printf "launch.connected_avg_ms=%.1f\nlaunch.connected_min_ms=%d\nlaunch.connected_max_ms=%d\n", sum/count, min, max
    }
  ' "$run_dir/launch-runs.txt" >>"$run_dir/summary.txt"
}

run_screen_benchmark() {
  ensure_screen_online
  capture_mem "$run_dir/screen-mem-before.txt"
  adb_cmd shell dumpsys gfxinfo "$PACKAGE" reset >/dev/null
  start_cpu_sampler "$run_dir/screen-cpu.txt" 18

  if [[ "$SCREEN_MODE" == "transition" ]]; then
    for _ in $(seq 1 "$SCREEN_LOOPS"); do
      adb_cmd shell input tap "$tab_screen_x" "$tab_y" >/dev/null
      sleep 1.0
      adb_cmd shell input tap "$tab_chat_x" "$tab_y" >/dev/null
      sleep 0.8
    done
  else
    adb_cmd shell input tap "$tab_screen_x" "$tab_y" >/dev/null
    sleep 1.5
    for _ in $(seq 1 "$SCREEN_LOOPS"); do
      adb_cmd shell input swipe "$center_x" "$screen_swipe_bottom_y" "$center_x" "$screen_swipe_top_y" 250 >/dev/null
      sleep 0.35
      adb_cmd shell input swipe "$center_x" "$screen_swipe_mid_y" "$center_x" "$screen_swipe_low_y" 250 >/dev/null
      sleep 0.35
    done
  fi

  wait "$CPU_SAMPLER_PID"
  adb_cmd shell dumpsys gfxinfo "$PACKAGE" >"$run_dir/screen-gfx.txt"
  capture_mem "$run_dir/screen-mem-after.txt"
  summarize_gfx "$run_dir/screen-gfx.txt" "screen"
  summarize_cpu "$run_dir/screen-cpu.txt" "screen"
  summarize_mem "$run_dir/screen-mem-before.txt" "screen.before"
  summarize_mem "$run_dir/screen-mem-after.txt" "screen.after"
}

run_chat_benchmark() {
  ensure_chat_online
  capture_mem "$run_dir/chat-mem-before.txt"
  adb_cmd shell dumpsys gfxinfo "$PACKAGE" reset >/dev/null
  start_cpu_sampler "$run_dir/chat-cpu.txt" 18

  if [[ "$CHAT_MODE" == "session-switch" ]]; then
    for _ in $(seq 1 "$CHAT_LOOPS"); do
      adb_cmd shell input tap "$chat_session_left_x" "$chat_session_y" >/dev/null
      sleep 0.8
      adb_cmd shell input tap "$chat_session_right_x" "$chat_session_y" >/dev/null
      sleep 0.8
    done
  else
    for _ in $(seq 1 "$CHAT_LOOPS"); do
      adb_cmd shell input swipe "$center_x" "$chat_swipe_bottom_y" "$center_x" "$chat_swipe_top_y" 250 >/dev/null
      sleep 0.35
      adb_cmd shell input swipe "$center_x" "$chat_swipe_mid_y" "$center_x" "$chat_swipe_bottom_y" 250 >/dev/null
      sleep 0.35
    done
  fi

  wait "$CPU_SAMPLER_PID"
  adb_cmd shell dumpsys gfxinfo "$PACKAGE" >"$run_dir/chat-gfx.txt"
  capture_mem "$run_dir/chat-mem-after.txt"
  summarize_gfx "$run_dir/chat-gfx.txt" "chat"
  summarize_cpu "$run_dir/chat-cpu.txt" "chat"
  summarize_mem "$run_dir/chat-mem-before.txt" "chat.before"
  summarize_mem "$run_dir/chat-mem-after.txt" "chat.after"
}

printf 'device.serial=%s\n' "${DEVICE_SERIAL:-default}" >"$run_dir/summary.txt"
printf 'device.display=%sx%s\n' "$display_width" "$display_height" >>"$run_dir/summary.txt"
printf 'config.launch_runs=%s\n' "$LAUNCH_RUNS" >>"$run_dir/summary.txt"
printf 'config.screen_loops=%s\n' "$SCREEN_LOOPS" >>"$run_dir/summary.txt"
printf 'config.chat_loops=%s\n' "$CHAT_LOOPS" >>"$run_dir/summary.txt"
printf 'config.screen_mode=%s\n' "$SCREEN_MODE" >>"$run_dir/summary.txt"
printf 'config.chat_mode=%s\n' "$CHAT_MODE" >>"$run_dir/summary.txt"

ensure_connected
measure_launch
ensure_connected
run_screen_benchmark
ensure_connected
run_chat_benchmark

printf 'results_dir=%s\n' "$run_dir"
cat "$run_dir/summary.txt"
