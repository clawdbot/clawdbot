#!/bin/bash
set -euo pipefail

PATH_CLEAN="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
MANIFEST_SHA="076e7810d9a463f3d7f034f9429bd5dcb3ed72203d06e1636f221668ec327962"
SELF_TEST_TEMP=""
JOB_BUDGET_SECONDS=900
PRE_CLOCK_ALLOWANCE_SECONDS=120
TRACE_STEP_SECONDS=540
COLLECTION_RESERVE_SECONDS=60
CANCELLATION_MARGIN_SECONDS=30

die() {
  echo "error: $*" >&2
  exit 1
}

mono() {
  /usr/bin/perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC \
    -e 'printf "%.3f\n", clock_gettime(CLOCK_MONOTONIC)'
}

elapsed() {
  awk -v start="$1" -v end="$2" 'BEGIN { printf "%.3f", end - start }'
}

stats_json() {
  local path="$1"
  local files=0
  local bytes=0
  local present=false
  if [[ -d "$path" ]]; then
    present=true
    files=$(find "$path" -type f | wc -l | awk '{ print $1 }')
    bytes=$(du -sk "$path" | awk '{ print $1 * 1024 }')
  fi
  jq -cn \
    --argjson present "$present" \
    --argjson files "$files" \
    --argjson bytes "$bytes" \
    '{exists: $present, files: $files, bytes: $bytes}'
}

require_context() {
  [[ "${SANDBOX_MODE:-}" == "on" || "${SANDBOX_MODE:-}" == "off" ]] ||
    die "SANDBOX_MODE must be on or off"
  [[ -n "${RUNNER_TEMP:-}" ]] || die "RUNNER_TEMP is required"
  [[ -n "${RUNNER_TRACKING_ID:-}" ]] || die "RUNNER_TRACKING_ID is required"
  [[ -n "${DEVELOPER_DIR:-}" ]] || die "DEVELOPER_DIR is required"
  ROOT="$RUNNER_TEMP/codeql-swift-manifest-$SANDBOX_MODE"
  RECEIPTS="$ROOT/receipts"
  SCRIPT="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
  SWIFT_BIN=$(xcrun --find swift)
}

phase_root() {
  echo "$ROOT/$1"
}

clean_env() {
  local phase="$1"
  shift
  local phase_dir
  phase_dir=$(phase_root "$phase")
  env -i \
    HOME="$phase_dir/home" \
    TMPDIR="$phase_dir/tmp" \
    PATH="$PATH_CLEAN" \
    DEVELOPER_DIR="$DEVELOPER_DIR" \
    LANG="en_US.UTF-8" \
    LC_ALL="en_US.UTF-8" \
    RUNNER_TRACKING_ID="$RUNNER_TRACKING_ID" \
    RUNNER_TEMP="$RUNNER_TEMP" \
    DIAGNOSTIC_ROOT="$ROOT" \
    DIAGNOSTIC_PHASE="$phase" \
    SANDBOX_MODE="$SANDBOX_MODE" \
    SWIFT_BIN="$SWIFT_BIN" \
    CLANG_MODULE_CACHE_PATH="$phase_dir/module-cache" \
    SWIFTPM_MODULECACHE_OVERRIDE="$phase_dir/module-cache" \
    SEMMLE_COPY_EXECUTABLES_ROOT="$phase_dir/relocation" \
    CODEQL_TRACER_LOG="$phase_dir/tracer/build-tracer.log" \
    CODEQL_TRACER_DIAGNOSTICS_DIR="$phase_dir/tracer/diagnostics" \
    "$@"
}

controller_receipt() {
  local phase="$1"
  local state="$2"
  local exit_code="${3:-}"
  jq -n \
    --arg phase "$phase" \
    --arg state "$state" \
    --argjson time "$(mono)" \
    --arg exit "$exit_code" \
    '{phase: $phase, state: $state, monotonicSeconds: $time}
      + if $exit == "" then {} else {exitCode: ($exit | tonumber)} end' \
    > "$RECEIPTS/$phase-controller-$state.json"
}

prepare() {
  local start
  local end
  local fixture
  local xcode
  local fingerprint
  start=$(mono)
  [[ ! -e "$ROOT" ]] || die "diagnostic root already exists"
  mkdir -p "$RECEIPTS" "$ROOT/fixture"
  for phase in prepare baseline traced; do
    local dir
    dir=$(phase_root "$phase")
    mkdir -p \
      "$dir/home" "$dir/tmp" "$dir/cache" "$dir/scratch" \
      "$dir/module-cache" "$dir/source" "$dir/tracer"
  done

  [[ "$(uname -m)" == "x86_64" ]] || die "expected Intel host"
  xcode=$(xcodebuild -version)
  [[ "$xcode" == Xcode\ 26.6* ]] || die "expected Xcode 26.6"
  fixture="$ROOT/fixture/Package.swift"
  clean_env prepare /usr/bin/curl \
    --fail --silent --show-error --location --max-time 20 \
    --output "$fixture" "$SPARKLE_MANIFEST_URL"
  [[ "$(shasum -a 256 "$fixture" | awk '{ print $1 }')" == "$MANIFEST_SHA" ]] ||
    die "Sparkle manifest hash mismatch"
  [[ "$SPARKLE_MANIFEST_SHA256" == "$MANIFEST_SHA" ]] || die "manifest input mismatch"
  [[ "$(wc -l < "$fixture" | awk '{ print $1 }')" -eq 26 ]] || die "manifest line mismatch"
  [[ "$(wc -c < "$fixture" | awk '{ print $1 }')" -eq 857 ]] || die "manifest byte mismatch"
  cp "$fixture" "$(phase_root baseline)/source/Package.swift"
  cp "$fixture" "$(phase_root traced)/source/Package.swift"

  jq -n \
    --arg image_os "${ImageOS:-unknown}" \
    --arg image_version "${ImageVersion:-unknown}" \
    --arg macos "$(sw_vers -productVersion)" \
    --arg architecture "$(uname -m)" \
    --arg xcode "$xcode" \
    --arg swift "$("$SWIFT_BIN" --version)" \
    --arg node "$(node --version)" \
    --arg manifest "$MANIFEST_SHA" \
    '{
      imageOS: $image_os,
      imageVersion: $image_version,
      macOS: $macos,
      architecture: $architecture,
      xcode: $xcode,
      swift: $swift,
      node: $node,
      manifestSha256: $manifest
    }' > "$RECEIPTS/environment-fingerprint.json"
  fingerprint=$(shasum -a 256 "$RECEIPTS/environment-fingerprint.json" | awk '{ print $1 }')
  end=$(mono)
  jq -n \
    --arg sandbox "$SANDBOX_MODE" \
    --argjson start "$start" \
    --argjson end "$end" \
    --argjson elapsed "$(elapsed "$start" "$end")" \
    --arg fingerprint "$fingerprint" \
    '{
      sandbox: $sandbox,
      startMonotonicSeconds: $start,
      endMonotonicSeconds: $end,
      elapsedSeconds: $elapsed,
      runnerTrackingIdPresent: true,
      environmentFingerprintSha256: $fingerprint,
      coldPaths: {
        baselineCopyRootAbsent: true,
        baselineTracerLogAbsent: true,
        tracedCopyRootAbsent: true,
        tracedTracerLogAbsent: true
      }
    }' > "$RECEIPTS/prepare.json"
}

manifest_child() {
  local phase="$1"
  local dir="$DIAGNOSTIC_ROOT/$phase"
  local copy_root="${SEMMLE_COPY_EXECUTABLES_ROOT:-}"
  local tracer_log="${CODEQL_TRACER_LOG:-}"
  local entry
  local start
  local end
  local status
  local output="$dir/manifest.json"
  local stderr="$dir/manifest.stderr.log"
  local tracing=false

  [[ "$phase" == "baseline" || "$phase" == "traced" ]] || die "invalid child phase"
  [[ "$DIAGNOSTIC_PHASE" == "$phase" ]] || die "child phase mismatch"
  [[ -n "$RUNNER_TRACKING_ID" ]] || die "child lost RUNNER_TRACKING_ID"
  [[ -x "$SWIFT_BIN" ]] || die "SWIFT_BIN is not executable"
  [[ -n "${DYLD_INSERT_LIBRARIES:-}" && -n "${SEMMLE_PRELOAD_libtrace:-}" ]] && tracing=true

  entry=$(mono)
  jq -n \
    --arg phase "$phase" \
    --argjson entry "$entry" \
    --arg home "$HOME" \
    --arg temp "$TMPDIR" \
    --arg modules "$SWIFTPM_MODULECACHE_OVERRIDE" \
    --arg copy "$copy_root" \
    --arg log "$tracer_log" \
    --arg diagnostics "${CODEQL_TRACER_DIAGNOSTICS_DIR:-}" \
    --arg languages "${CODEQL_TRACER_LANGUAGES:-}" \
    --argjson tracing "$tracing" \
    --argjson copy_stats "$(stats_json "$copy_root")" \
    '{
      phase: $phase,
      entryMonotonicSeconds: $entry,
      runnerTrackingIdPresent: true,
      tracingInjected: $tracing,
      tracerLanguages: $languages,
      effectiveHome: $home,
      effectiveTemp: $temp,
      effectiveModuleCache: $modules,
      effectiveCopyRoot: $copy,
      effectiveTracerLog: $log,
      effectiveTracerDiagnostics: $diagnostics,
      copyRootAtEntry: $copy_stats
    }' > "$DIAGNOSTIC_ROOT/receipts/$phase-child-entry.json"

  start=$(mono)
  set +e
  if [[ "$SANDBOX_MODE" == "off" ]]; then
    "$SWIFT_BIN" package \
      --package-path "$dir/source" --cache-path "$dir/cache" --scratch-path "$dir/scratch" \
      --manifest-cache none --disable-sandbox dump-package >"$output" 2>"$stderr"
  else
    "$SWIFT_BIN" package \
      --package-path "$dir/source" --cache-path "$dir/cache" --scratch-path "$dir/scratch" \
      --manifest-cache none dump-package >"$output" 2>"$stderr"
  fi
  status=$?
  set -e
  end=$(mono)

  local output_sha=""
  local output_bytes=0
  if [[ "$status" -eq 0 ]]; then
    jq -e . "$output" >/dev/null || die "manifest output is not JSON"
    output_bytes=$(wc -c < "$output" | awk '{ print $1 }')
    [[ "$output_bytes" -le 65536 ]] || die "manifest output exceeds 64 KiB"
    output_sha=$(shasum -a 256 "$output" | awk '{ print $1 }')
  fi
  jq -n \
    --arg phase "$phase" \
    --argjson start "$start" \
    --argjson end "$end" \
    --argjson elapsed "$(elapsed "$start" "$end")" \
    --argjson exit "$status" \
    --arg sha "$output_sha" \
    --argjson bytes "$output_bytes" \
    '{
      phase: $phase,
      startMonotonicSeconds: $start,
      endMonotonicSeconds: $end,
      elapsedSeconds: $elapsed,
      exitCode: $exit,
      manifest: {sha256: $sha, bytes: $bytes}
    }' > "$DIAGNOSTIC_ROOT/receipts/$phase-child-completion.json"
  return "$status"
}

baseline() {
  local status
  controller_receipt baseline started
  set +e
  clean_env baseline "$SCRIPT" manifest-child baseline \
    >"$(phase_root baseline)/controller.stdout.log" \
    2>"$(phase_root baseline)/controller.stderr.log"
  status=$?
  set -e
  controller_receipt baseline completed "$status"
  return "$status"
}

admission_allowed() {
  local measured_elapsed="$1"
  awk \
    -v job="$JOB_BUDGET_SECONDS" \
    -v preclock="$PRE_CLOCK_ALLOWANCE_SECONDS" \
    -v measured="$measured_elapsed" \
    -v trace="$TRACE_STEP_SECONDS" \
    -v collection="$COLLECTION_RESERVE_SECONDS" \
    -v cancel="$CANCELLATION_MARGIN_SECONDS" \
    'BEGIN { exit !((job - preclock - measured) >= (trace + collection + cancel)) }'
}

admit_trace() {
  local prepare_receipt="$RECEIPTS/prepare.json"
  local prepare_start
  local now
  local measured
  local conservative_elapsed
  local remaining
  local required
  local admitted=false

  [[ -f "$prepare_receipt" ]] || die "prepare receipt is required for trace admission"
  prepare_start=$(jq -r '.startMonotonicSeconds' "$prepare_receipt")
  now=$(mono)
  measured=$(elapsed "$prepare_start" "$now")
  conservative_elapsed=$(awk \
    -v measured="$measured" -v allowance="$PRE_CLOCK_ALLOWANCE_SECONDS" \
    'BEGIN { printf "%.3f", measured + allowance }')
  remaining=$(awk \
    -v job="$JOB_BUDGET_SECONDS" -v elapsed="$conservative_elapsed" \
    'BEGIN { printf "%.3f", job - elapsed }')
  required=$(( TRACE_STEP_SECONDS + COLLECTION_RESERVE_SECONDS + CANCELLATION_MARGIN_SECONDS ))
  admission_allowed "$measured" && admitted=true

  jq -n \
    --argjson admitted "$admitted" \
    --argjson checked_at "$now" \
    --argjson measured "$measured" \
    --argjson preclock "$PRE_CLOCK_ALLOWANCE_SECONDS" \
    --argjson conservative "$conservative_elapsed" \
    --argjson remaining "$remaining" \
    --argjson trace "$TRACE_STEP_SECONDS" \
    --argjson collection "$COLLECTION_RESERVE_SECONDS" \
    --argjson cancel "$CANCELLATION_MARGIN_SECONDS" \
    --argjson required "$required" \
    '{
      admitted: $admitted,
      checkedAtMonotonicSeconds: $checked_at,
      measuredSincePrepareClockSeconds: $measured,
      preClockAllowanceSeconds: $preclock,
      preClockAllowanceBasis: {
        checkoutStepUpperBoundSeconds: 60,
        preparationBeforeClockUpperBoundSeconds: 60
      },
      conservativeElapsedSeconds: $conservative,
      conservativeRemainingJobSeconds: $remaining,
      requiredRemainingSeconds: $required,
      reservation: {
        tracedStepSeconds: $trace,
        collectionSeconds: $collection,
        cancellationMarginSeconds: $cancel
      },
      refusalClassification: "skipped-insufficient-job-budget"
    }' > "$RECEIPTS/trace-admission.json"

  [[ "$admitted" == true ]] || {
    echo "error: insufficient reserved job time for bounded trace and collection" >&2
    return 78
  }
}

traced() {
  local dir
  local database
  local codeql_logs
  local requested_copy
  local requested_log
  local status

  [[ -x "${CODEQL_BIN:-}" ]] || die "CODEQL_BIN is not executable"
  [[ "${EXPECTED_CODEQL_VERSION:-}" == "2.26.4" ]] || die "unexpected CodeQL version"
  [[ "$SETUP_CODEQL_VERSION" == "$EXPECTED_CODEQL_VERSION" ]] ||
    die "setup-codeql version mismatch"
  dir=$(phase_root traced)
  database="$dir/database"
  codeql_logs="$dir/codeql-logs"
  requested_copy="$dir/relocation"
  requested_log="$dir/tracer/build-tracer.log"
  mkdir -p "$codeql_logs"
  admit_trace || return $?

  clean_env traced "$CODEQL_BIN" version --format=json >"$RECEIPTS/codeql-version.json"
  [[ "$(jq -r '.version' "$RECEIPTS/codeql-version.json")" == "2.26.4" ]] ||
    die "CodeQL binary version mismatch"
  clean_env traced "$CODEQL_BIN" database init -h >"$RECEIPTS/database-init-help.txt"
  clean_env traced "$CODEQL_BIN" database trace-command -h >"$RECEIPTS/trace-command-help.txt"
  grep -q -- '--build-mode' "$RECEIPTS/database-init-help.txt" || die "missing --build-mode"
  grep -q -- '--source-root' "$RECEIPTS/database-init-help.txt" || die "missing --source-root"
  grep -q -- '--logdir' "$RECEIPTS/database-init-help.txt" || die "missing --logdir"
  grep -q -- '--working-dir' "$RECEIPTS/trace-command-help.txt" || die "missing --working-dir"
  grep -q -- '--verbosity' "$RECEIPTS/trace-command-help.txt" || die "missing --verbosity"
  [[ ! -e "$requested_copy" && ! -e "$requested_log" ]] ||
    die "tracing paths existed before database init"

  jq -n \
    --arg copy "$requested_copy" \
    --arg log "$requested_log" \
    --arg logs "$codeql_logs" \
    --argjson time "$(mono)" \
    '{
      monotonicSeconds: $time,
      requestedCopyRoot: $copy,
      requestedTracerLog: $log,
      codeqlLogDirectory: $logs,
      copyRootExistsBeforeDatabaseInit: false,
      tracerLogExistsBeforeDatabaseInit: false
    }' > "$RECEIPTS/pretrace.json"

  clean_env traced "$CODEQL_BIN" database init \
    --overwrite --language=swift --build-mode=manual \
    --source-root="$dir/source" --logdir="$codeql_logs" --verbosity=progress \
    "$database" >"$dir/database-init.stdout.log" 2>"$dir/database-init.stderr.log"
  jq -n \
    --argjson time "$(mono)" \
    --argjson copy "$(stats_json "$requested_copy")" \
    --argjson log_exists "$([[ -f "$requested_log" ]] && echo true || echo false)" \
    '{
      monotonicSeconds: $time,
      requestedCopyRootAfterDatabaseInit: $copy,
      requestedTracerLogExistsAfterDatabaseInit: $log_exists
    }' > "$RECEIPTS/post-init.json"

  controller_receipt traced started
  set +e
  clean_env traced "$CODEQL_BIN" database trace-command \
    --logdir="$codeql_logs" --verbosity=progress --working-dir="$dir/source" \
    "$database" -- "$SCRIPT" manifest-child traced \
    >"$dir/trace-command.stdout.log" 2>"$dir/trace-command.stderr.log"
  status=$?
  set -e
  controller_receipt traced completed "$status"
  return "$status"
}

typed_log() {
  local input="$1"
  local output="$2"
  env -i PATH="$PATH_CLEAN" LANG=C LC_ALL=C python3 - "$input" "$output" <<'PY'
import hashlib, json, os, re, sys

source, target = sys.argv[1:]
if not source or not os.path.isfile(source):
    json.dump({"present": False, "inputPath": source, "rawLinesEmitted": False}, open(target, "w"))
    sys.exit()

exact = {
    "Intercepted call to": "interceptedCall",
    "Execute matcher for language": "executeLanguageMatcher",
    "Disabling tracing for language": "tracingDisabled",
    "preInvocations": "preInvocations",
    "compilerReplacement": "compilerReplacement",
    "postInvocations": "postInvocations",
    "traceLanguages": "traceLanguages",
}
counts = {value: 0 for value in exact.values()}
keywords = {"copyOrRelocation": 0, "patch": 0, "signing": 0, "ipcOrWait": 0}
first, last, total, unmatched = [], [], 0, 0
with open(source, errors="replace") as stream:
    for raw in stream:
        total += 1
        line = raw.rstrip("\n")
        item = (total, line)
        if len(first) < 12:
            first.append(item)
        else:
            last.append(item)
            last = last[-12:]
        matched = False
        for needle, key in exact.items():
            if needle in line:
                counts[key] += 1
                matched = True
        unmatched += not matched
        keywords["copyOrRelocation"] += bool(re.search(r"copy|relocat", line, re.I))
        keywords["patch"] += bool(re.search(r"patch", line, re.I))
        keywords["signing"] += bool(re.search(r"codesign|sign", line, re.I))
        keywords["ipcOrWait"] += bool(re.search(r"ipc|socket|pipe|connect|wait", line, re.I))

def typed(number, region, line):
    stage = next((value for needle, value in exact.items() if needle in line), "unmatched")
    binary = next((x for x in ("swift-frontend", "swift-driver", "sandbox-exec", "codesign", "extractor", "libtrace.dylib") if x in line), None)
    timestamp = re.search(r"\d{4}-\d{2}-\d{2}T[\d:.+-]+Z", line)
    duration = re.search(r"\b\d+(?:\.\d+)?(?:ms|s)\b", line)
    outcome = "error-keyword" if re.search(r"error|fail", line, re.I) else "completion-keyword" if re.search(r"success|complet", line, re.I) else "unknown"
    return {
        "line": number, "region": region,
        "lineSha256": hashlib.sha256(line.encode()).hexdigest(),
        "timestamp": timestamp.group(0) if timestamp else None,
        "duration": duration.group(0) if duration else None,
        "binaryBasename": binary, "stage": stage, "outcome": outcome,
    }

evidence = [typed(n, "start", line) for n, line in first]
evidence += [typed(n, "end", line) for n, line in last]
result = {
    "present": True, "inputPath": source, "rawLinesEmitted": False,
    "bytes": os.path.getsize(source), "lines": total,
    "retainedStartLines": len(first), "retainedEndLines": len(last),
    "middleLinesOmitted": total - len(evidence),
    "unmatchedOrUnclassifiedLines": unmatched,
    "exactCodeqlEvents": counts, "keywordLinesOnly": keywords,
    "retainedTypedEvidence": evidence,
}
json.dump(result, open(target, "w"), indent=2)
PY
}

json_or_null() {
  [[ -f "$1" ]] && jq -c . "$1" 2>/dev/null || echo null
}

contained() {
  [[ -n "$2" && "$2" == "$1"/* ]]
}

classification() {
  local outcome="$1"
  local child_completion="$2"
  local controller_completion="$3"
  local admission="$4"
  if [[ "$admission" != null && "$(jq -r '.admitted' <<<"$admission")" == false ]]; then
    echo skipped-insufficient-job-budget
  elif [[ "$outcome" == success &&
    "$child_completion" != null &&
    "$controller_completion" != null &&
    "$(jq -r '.exitCode' <<<"$child_completion")" == 0 &&
    "$(jq -r '.exitCode' <<<"$controller_completion")" == 0 ]]; then
    echo completed
  elif [[ "$child_completion" != null && "$controller_completion" != null ]]; then
    echo failed
  elif [[ "$outcome" == skipped ]]; then
    echo skipped
  elif [[ "$outcome" == failure || "$outcome" == cancelled ]]; then
    echo interrupted-or-unknown
  else
    echo missing-or-unknown
  fi
}

collect() {
  local baseline_entry
  local baseline_done
  local baseline_controller
  local traced_entry
  local traced_done
  local traced_controller
  local admission
  local pretrace
  local tracer_log=""
  local copy_root=""
  local baseline_copy=""
  local safety_verified=false
  local safe=false

  mkdir -p "$RECEIPTS"
  baseline_entry=$(json_or_null "$RECEIPTS/baseline-child-entry.json")
  baseline_done=$(json_or_null "$RECEIPTS/baseline-child-completion.json")
  baseline_controller=$(json_or_null "$RECEIPTS/baseline-controller-completed.json")
  traced_entry=$(json_or_null "$RECEIPTS/traced-child-entry.json")
  traced_done=$(json_or_null "$RECEIPTS/traced-child-completion.json")
  traced_controller=$(json_or_null "$RECEIPTS/traced-controller-completed.json")
  admission=$(json_or_null "$RECEIPTS/trace-admission.json")
  pretrace=$(json_or_null "$RECEIPTS/pretrace.json")
  if [[ "$baseline_entry" != null && "$traced_entry" != null ]]; then
    safety_verified=true
    safe=true
    baseline_copy=$(jq -r '.effectiveCopyRoot' <<<"$baseline_entry")
    [[ "$(jq -r '.tracingInjected' <<<"$baseline_entry")" == false ]] || safe=false
    for field in effectiveHome effectiveTemp effectiveModuleCache effectiveCopyRoot effectiveTracerLog; do
      contained "$(phase_root baseline)" "$(jq -r ".$field" <<<"$baseline_entry")" || safe=false
    done
    copy_root=$(jq -r '.effectiveCopyRoot' <<<"$traced_entry")
    tracer_log=$(jq -r '.effectiveTracerLog' <<<"$traced_entry")
    [[ "$(jq -r '.tracingInjected' <<<"$traced_entry")" == true ]] || safe=false
    [[ "$(jq -r '.tracerLanguages' <<<"$traced_entry")" == *swift* ]] || safe=false
    for field in effectiveHome effectiveTemp effectiveModuleCache effectiveCopyRoot effectiveTracerLog; do
      contained "$(phase_root traced)" "$(jq -r ".$field" <<<"$traced_entry")" || safe=false
    done
    [[ -n "$baseline_copy" && "$copy_root" != "$baseline_copy" ]] || safe=false
    [[ "$pretrace" != null ]] || safe=false
    [[ "$copy_root" == "$(jq -r '.requestedCopyRoot' <<<"$pretrace")" ]] || safe=false
    [[ "$tracer_log" == "$(jq -r '.requestedTracerLog' <<<"$pretrace")" ]] || safe=false
  fi
  typed_log "$tracer_log" "$RECEIPTS/tracer-log-summary.json"

  jq -n \
    --arg sandbox "$SANDBOX_MODE" \
    --arg prepare_outcome "${PREPARE_OUTCOME:-unknown}" \
    --arg baseline_outcome "${BASELINE_OUTCOME:-unknown}" \
    --arg setup_outcome "${SETUP_OUTCOME:-unknown}" \
    --arg traced_outcome "${TRACED_OUTCOME:-unknown}" \
    --arg baseline_class "$(classification "${BASELINE_OUTCOME:-unknown}" "$baseline_done" "$baseline_controller" null)" \
    --arg traced_class "$(classification "${TRACED_OUTCOME:-unknown}" "$traced_done" "$traced_controller" "$admission")" \
    --argjson safety_verified "$safety_verified" \
    --argjson safe "$safe" \
    --argjson prepare "$(json_or_null "$RECEIPTS/prepare.json")" \
    --argjson fingerprint "$(json_or_null "$RECEIPTS/environment-fingerprint.json")" \
    --argjson codeql "$(json_or_null "$RECEIPTS/codeql-version.json")" \
    --argjson baseline_entry "$baseline_entry" \
    --argjson baseline_done "$baseline_done" \
    --argjson traced_start "$(json_or_null "$RECEIPTS/traced-controller-started.json")" \
    --argjson traced_entry "$traced_entry" \
    --argjson traced_done "$traced_done" \
    --argjson traced_end "$traced_controller" \
    --argjson admission "$admission" \
    --argjson pretrace "$pretrace" \
    --argjson post_init "$(json_or_null "$RECEIPTS/post-init.json")" \
    --argjson copy_after "$(stats_json "$copy_root")" \
    --argjson tracer "$(cat "$RECEIPTS/tracer-log-summary.json")" \
    '{
      diagnostic: "CodeQL Swift manifest tracer",
      neverMerge: true,
      qualification: false,
      sandbox: $sandbox,
      fixtureScope: "standalone manifest; no resolver or Git-tag context",
      outcomes: {
        prepare: $prepare_outcome,
        baseline: $baseline_outcome,
        setupCodeql: $setup_outcome,
        traced: $traced_outcome,
        baselineClassification: $baseline_class,
        tracedClassification: $traced_class
      },
      prepare: $prepare,
      environmentFingerprint: $fingerprint,
      codeqlFingerprint: $codeql,
      baseline: {childEntry: $baseline_entry, completion: $baseline_done},
      traced: {
        controllerStart: $traced_start,
        admission: $admission,
        childEntry: $traced_entry,
        childCompletion: $traced_done,
        controllerCompletion: $traced_end,
        pretrace: $pretrace,
        postDatabaseInit: $post_init,
        copyRootAfter: $copy_after,
        tracerLog: $tracer
      },
      isolation: {
        verified: $safety_verified,
        safetyChecksPassed: (if $safety_verified then $safe else null end)
      },
      interpretationLimits: [
        "Step failure alone does not prove timeout; missing completion is interrupted or unknown.",
        "Keyword counts are observations, not a relocation or IPC schema.",
        "Silence or interception counts do not disprove relocation or IPC activity.",
        "Compare sandbox jobs only when environment fingerprints match."
      ]
    }' > "$RECEIPTS/summary.json"
  jq . "$RECEIPTS/summary.json"
  {
    echo "## CodeQL Swift manifest tracer ($SANDBOX_MODE)"
    echo
    echo '```json'
    jq . "$RECEIPTS/summary.json"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
  if [[ "$safety_verified" == true && "$safe" != true ]]; then
    die "effective paths failed isolation checks"
  fi
}

self_test() {
  local log
  local summary
  SELF_TEST_TEMP=$(mktemp -d)
  trap 'rm -rf "$SELF_TEST_TEMP"' EXIT
  ROOT="$SELF_TEST_TEMP"
  RUNNER_TEMP="$SELF_TEST_TEMP"
  RUNNER_TRACKING_ID="self-test-tracking-id"
  DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
  SANDBOX_MODE=on
  SWIFT_BIN=/usr/bin/swift
  mkdir -p "$ROOT/baseline"/{home,tmp,module-cache,tracer}
  clean_env baseline /usr/bin/env > "$ROOT/child.env"
  [[ "$(grep -c '^RUNNER_TRACKING_ID=self-test-tracking-id$' "$ROOT/child.env")" -eq 1 ]] ||
    die "clean environment lost RUNNER_TRACKING_ID"
  ! grep -Eq '^(GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|SECRET|PASSWORD)=' "$ROOT/child.env" ||
    die "clean environment retained a credential key"

  log="$SELF_TEST_TEMP/build-tracer.log"
  summary="$SELF_TEST_TEMP/summary.json"
  for number in $(jot 25 1); do
    case "$number" in
      2) echo "2026-09-08T00:00:00Z Intercepted call to /private/path/swift-frontend --token secret" ;;
      24) echo "2026-09-08T00:00:02Z Execute matcher for language swift completed 2.0s" ;;
      *) echo "opaque line $number" ;;
    esac
  done > "$log"
  typed_log "$log" "$summary"
  jq -e '
    .lines == 25
    and .retainedStartLines == 12
    and .retainedEndLines == 12
    and .middleLinesOmitted == 1
    and .rawLinesEmitted == false
    and .exactCodeqlEvents.interceptedCall == 1
    and .exactCodeqlEvents.executeLanguageMatcher == 1
  ' "$summary" >/dev/null
  ! grep -Eq 'secret|/private/path|--token' "$summary" || die "typed log leaked raw input"
  admission_allowed 150 || die "trace admission rejected the exact reserved boundary"
  ! admission_allowed 151 || die "trace admission accepted insufficient reserved time"
  [[ "$(classification success '{"exitCode":0}' '{"exitCode":0}' null)" == completed ]] ||
    die "complete classification failed"
  [[ "$(classification success '{"exitCode":0}' null null)" == missing-or-unknown ]] ||
    die "partial completion was misclassified"
  [[ "$(classification failure null null '{"admitted":false}')" == skipped-insufficient-job-budget ]] ||
    die "admission refusal classification failed"
  echo "self-test: admission=pass classifications=pass clean-env=pass typed-log-boundary=pass truncation=pass"
}

COMMAND="${1:-}"
[[ "$COMMAND" == "--self-test" ]] && {
  self_test
  exit 0
}
require_context

case "$COMMAND" in
  prepare) prepare ;;
  baseline) baseline ;;
  traced) traced ;;
  manifest-child) manifest_child "${2:-}" ;;
  collect) collect ;;
  *) die "usage: $0 {prepare|baseline|traced|manifest-child|collect|--self-test}" ;;
esac
