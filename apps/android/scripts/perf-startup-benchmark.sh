#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RESULTS_DIR="$ANDROID_DIR/benchmark/results"
CLASS_FILTER="ai.openclaw.app.benchmark.StartupMacrobenchmark#coldStartup"
BASELINE_JSON=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/perf-startup-benchmark.sh [--baseline <benchmarkData.json>]

Runs cold-start macrobenchmark only, then prints a compact summary.
Also saves a timestamped snapshot JSON under benchmark/results/.
If --baseline is omitted, compares against latest previous snapshot when available.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline)
      BASELINE_JSON="${2:-}"
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

if ! command -v jq >/dev/null 2>&1; then
  echo "jq required but missing." >&2
  exit 1
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "adb required but missing." >&2
  exit 1
fi

device_count="$(adb devices | awk 'NR>1 && $2=="device" {c+=1} END {print c+0}')"
if [[ "$device_count" -lt 1 ]]; then
  echo "No connected Android device (adb state=device)." >&2
  exit 1
fi

mkdir -p "$RESULTS_DIR"

run_log="$(mktemp -t openclaw-android-bench.XXXXXX.log)"
trap 'rm -f "$run_log"' EXIT

cd "$ANDROID_DIR"

./gradlew :benchmark:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class="$CLASS_FILTER" \
  --console=plain \
  >"$run_log" 2>&1

latest_json="$(
  find "$ANDROID_DIR/benchmark/build/outputs/connected_android_test_additional_output/debug/connected" \
    -name '*benchmarkData.json' -type f \
    | while IFS= read -r file; do
        printf '%s\t%s\n' "$(stat -f '%m' "$file")" "$file"
      done \
    | sort -nr \
    | head -n1 \
    | cut -f2-
)"

if [[ -z "$latest_json" || ! -f "$latest_json" ]]; then
  echo "benchmarkData.json not found after run." >&2
  tail -n 120 "$run_log" >&2
  exit 1
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
snapshot_json="$RESULTS_DIR/startup-$timestamp.json"
cp "$latest_json" "$snapshot_json"

median_ms="$(jq -r '.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.median' "$snapshot_json")"
min_ms="$(jq -r '.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.minimum' "$snapshot_json")"
max_ms="$(jq -r '.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.maximum' "$snapshot_json")"
cov="$(jq -r '.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.coefficientOfVariation' "$snapshot_json")"
device="$(jq -r '.context.build.model' "$snapshot_json")"
sdk="$(jq -r '.context.build.version.sdk' "$snapshot_json")"
runs_count="$(jq -r '.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.runs | length' "$snapshot_json")"

printf 'startup.cold.median_ms=%.3f min_ms=%.3f max_ms=%.3f cov=%.4f runs=%s device=%s sdk=%s\n' \
  "$median_ms" "$min_ms" "$max_ms" "$cov" "$runs_count" "$device" "$sdk"
echo "snapshot_json=$snapshot_json"

if [[ -z "$BASELINE_JSON" ]]; then
  BASELINE_JSON="$(
    find "$RESULTS_DIR" -name 'startup-*.json' -type f \
      | while IFS= read -r file; do
          if [[ "$file" == "$snapshot_json" ]]; then
            continue
          fi
          printf '%s\t%s\n' "$(stat -f '%m' "$file")" "$file"
        done \
      | sort -nr \
      | head -n1 \
      | cut -f2-
  )"
fi

if [[ -n "$BASELINE_JSON" ]]; then
  if [[ ! -f "$BASELINE_JSON" ]]; then
    echo "Baseline file missing: $BASELINE_JSON" >&2
    exit 1
  fi
  base_median="$(jq -r '.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.median' "$BASELINE_JSON")"
  delta_ms="$(awk -v a="$median_ms" -v b="$base_median" 'BEGIN { printf "%.3f", (a-b) }')"
  delta_pct="$(awk -v a="$median_ms" -v b="$base_median" 'BEGIN { if (b==0) { print "nan" } else { printf "%.2f", ((a-b)/b)*100 } }')"
  echo "baseline_median_ms=$base_median delta_ms=$delta_ms delta_pct=$delta_pct%"
fi
