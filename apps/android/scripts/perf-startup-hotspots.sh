#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

PACKAGE="ai.openclaw.app.debug"
ACTIVITY="ai.openclaw.app.MainActivity"
DURATION_SECONDS="10"
OUTPUT_PERF_DATA=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/perf-startup-hotspots.sh [--package <pkg>] [--activity <activity>] [--duration <sec>] [--out <perf.data>]

Captures startup CPU profile via simpleperf (app_profiler.py), then prints concise hotspot summaries.
Default package/activity target OpenClaw Android startup.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package)
      PACKAGE="${2:-}"
      shift 2
      ;;
    --activity)
      ACTIVITY="${2:-}"
      shift 2
      ;;
    --duration)
      DURATION_SECONDS="${2:-}"
      shift 2
      ;;
    --out)
      OUTPUT_PERF_DATA="${2:-}"
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

if ! command -v uv >/dev/null 2>&1; then
  echo "uv required but missing." >&2
  exit 1
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "adb required but missing." >&2
  exit 1
fi

if [[ -z "$OUTPUT_PERF_DATA" ]]; then
  OUTPUT_PERF_DATA="/tmp/openclaw-startup-$(date +%Y%m%d-%H%M%S).perf.data"
fi

device_count="$(adb devices | awk 'NR>1 && $2=="device" {c+=1} END {print c+0}')"
if [[ "$device_count" -lt 1 ]]; then
  echo "No connected Android device (adb state=device)." >&2
  exit 1
fi

simpleperf_dir=""
if [[ -n "${ANDROID_NDK_HOME:-}" && -f "${ANDROID_NDK_HOME}/simpleperf/app_profiler.py" ]]; then
  simpleperf_dir="${ANDROID_NDK_HOME}/simpleperf"
elif [[ -n "${ANDROID_NDK_ROOT:-}" && -f "${ANDROID_NDK_ROOT}/simpleperf/app_profiler.py" ]]; then
  simpleperf_dir="${ANDROID_NDK_ROOT}/simpleperf"
else
  latest_simpleperf="$(ls -d "${HOME}/Library/Android/sdk/ndk/"*/simpleperf 2>/dev/null | sort -V | tail -n1 || true)"
  if [[ -n "$latest_simpleperf" && -f "$latest_simpleperf/app_profiler.py" ]]; then
    simpleperf_dir="$latest_simpleperf"
  fi
fi

if [[ -z "$simpleperf_dir" ]]; then
  echo "simpleperf not found. Set ANDROID_NDK_HOME or install NDK under ~/Library/Android/sdk/ndk/." >&2
  exit 1
fi

app_profiler="$simpleperf_dir/app_profiler.py"
report_py="$simpleperf_dir/report.py"
ndk_path="$(cd -- "$simpleperf_dir/.." && pwd)"

tmp_dir="$(mktemp -d -t openclaw-android-hotspots.XXXXXX)"
trap 'rm -rf "$tmp_dir"' EXIT

capture_log="$tmp_dir/capture.log"
dso_csv="$tmp_dir/dso.csv"
symbols_csv="$tmp_dir/symbols.csv"
children_txt="$tmp_dir/children.txt"

cd "$ANDROID_DIR"
./gradlew :app:installPlayDebug --console=plain >"$tmp_dir/install.log" 2>&1

if ! uv run --no-project python3 "$app_profiler" \
  -p "$PACKAGE" \
  -a "$ACTIVITY" \
  -o "$OUTPUT_PERF_DATA" \
  --ndk_path "$ndk_path" \
  -r "-e task-clock:u -f 1000 -g --duration $DURATION_SECONDS" \
  >"$capture_log" 2>&1; then
  echo "simpleperf capture failed. tail(capture_log):" >&2
  tail -n 120 "$capture_log" >&2
  exit 1
fi

uv run --no-project python3 "$report_py" \
  -i "$OUTPUT_PERF_DATA" \
  --sort dso \
  --csv \
  --csv-separator "|" \
  --include-process-name "$PACKAGE" \
  >"$dso_csv" 2>"$tmp_dir/report-dso.err"

uv run --no-project python3 "$report_py" \
  -i "$OUTPUT_PERF_DATA" \
  --sort dso,symbol \
  --csv \
  --csv-separator "|" \
  --include-process-name "$PACKAGE" \
  >"$symbols_csv" 2>"$tmp_dir/report-symbols.err"

uv run --no-project python3 "$report_py" \
  -i "$OUTPUT_PERF_DATA" \
  --children \
  --sort dso,symbol \
  -n \
  --percent-limit 0.2 \
  --include-process-name "$PACKAGE" \
  >"$children_txt" 2>"$tmp_dir/report-children.err"

clean_csv() {
  awk 'BEGIN{print_on=0} /^Overhead\|/{print_on=1} print_on==1{print}' "$1"
}

echo "perf_data=$OUTPUT_PERF_DATA"
echo
echo "top_dso_self:"
clean_csv "$dso_csv" | tail -n +2 | awk -F'|' 'NR<=10 {printf "  %s  %s\n", $1, $2}'
echo
echo "top_symbols_self:"
clean_csv "$symbols_csv" | tail -n +2 | awk -F'|' 'NR<=20 {printf "  %s  %s :: %s\n", $1, $2, $3}'
echo
echo "app_path_clues_children:"
rg 'androidx\.compose|MainActivity|NodeRuntime|NodeForegroundService|SecurePrefs|WebView|libwebviewchromium' "$children_txt" | awk 'NR<=20 {print}' || true
