#!/usr/bin/env bash

parallels_package_current_build_commit() {
  python3 - <<'PY'
import json
import pathlib

path = pathlib.Path("dist/build-info.json")
if not path.exists():
    print("")
else:
    print(json.loads(path.read_text()).get("commit", ""))
PY
}

parallels_package_acquire_build_lock() {
  local lock_dir="$1"
  local owner_pid=""
  while ! mkdir "$lock_dir" 2>/dev/null; do
    if [[ -f "$lock_dir/pid" ]]; then
      owner_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
      if [[ -n "$owner_pid" ]] && ! kill -0 "$owner_pid" >/dev/null 2>&1; then
        printf 'warn: Removing stale Parallels build lock\n' >&2
        rm -rf "$lock_dir"
        continue
      fi
    fi
    sleep 1
  done
  printf '%s\n' "$$" >"$lock_dir/pid"
}

parallels_package_release_build_lock() {
  local lock_dir="$1"
  if [[ -d "$lock_dir" ]]; then
    rm -rf "$lock_dir"
  fi
}

parallels_package_run_with_build_lock() {
  local lock_dir="$1"
  local rc
  shift
  parallels_package_acquire_build_lock "$lock_dir"
  set +e
  "$@"
  rc=$?
  set -e
  parallels_package_release_build_lock "$lock_dir"
  return "$rc"
}

parallels_package_write_dist_inventory() {
  node --import tsx --input-type=module --eval \
    'import { writePackageDistInventory } from "./src/infra/package-dist-inventory.ts"; await writePackageDistInventory(process.cwd());'
}

parallels_package_assert_no_generated_drift() {
  local drift
  drift="$(git status --porcelain -- src/canvas-host/a2ui/.bundle.hash 2>/dev/null || true)"
  if [[ -z "$drift" ]]; then
    return 0
  fi
  printf 'error: generated file drift after build; commit or revert before Parallels packaging:\n%s\n' "$drift" >&2
  return 1
}

parallels_log_progress_extract() {
  local python_bin="$1"
  local log_path="$2"
  "$python_bin" - "$log_path" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
if not path.exists():
    print("")
    raise SystemExit(0)

text = path.read_text(encoding="utf-8", errors="replace")
lines = [line.strip() for line in text.splitlines() if line.strip()]

for line in reversed(lines):
    if line.startswith("==> "):
        print(line[4:].strip())
        raise SystemExit(0)

for line in reversed(lines):
    if line.startswith("warn:") or line.startswith("error:"):
        print(line)
        raise SystemExit(0)

if lines:
    print(lines[-1][:240])
else:
    print("")
PY
}

parallels_child_job_running() {
  local target="$1"
  local owner="${2:-}"
  local ppid
  kill -0 "$target" >/dev/null 2>&1 || return 1
  if [[ -z "$owner" ]]; then
    return 0
  fi
  ppid="$(ps -o ppid= -p "$target" 2>/dev/null | tr -d '[:space:]')"
  [[ "$ppid" == "$owner" ]]
}

parallels_monitor_jobs_progress() {
  local group="$1"
  local interval_s="$2"
  local stale_s="$3"
  local python_bin="$4"
  local owner_pid="$5"
  shift 5

  local labels=()
  local pids=()
  local logs=()
  local last_progress=()
  local last_print=()
  local i summary now running

  while [[ $# -gt 0 ]]; do
    labels+=("$1")
    pids+=("$2")
    logs+=("$3")
    last_progress+=("")
    last_print+=(0)
    shift 3
  done

  printf '==> %s progress; run dir: %s\n' "$group" "${RUN_DIR:-unknown}"

  while :; do
    running=0
    now=$SECONDS
    for ((i = 0; i < ${#pids[@]}; i++)); do
      if ! parallels_child_job_running "${pids[$i]}" "$owner_pid"; then
        continue
      fi
      running=1
      summary="$(parallels_log_progress_extract "$python_bin" "${logs[$i]}")"
      [[ -n "$summary" ]] || summary="waiting for first log line"
      if [[ "${last_progress[i]}" != "$summary" ]] || (( now - last_print[i] >= stale_s )); then
        printf '==> %s %s: %s\n' "$group" "${labels[$i]}" "$summary"
        last_progress[i]="$summary"
        last_print[i]=$now
      fi
    done
    (( running )) || break
    sleep "$interval_s"
  done
}
