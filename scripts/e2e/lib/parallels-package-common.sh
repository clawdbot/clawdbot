#!/usr/bin/env bash

parallels_package_current_build_commit() {
  node scripts/e2e/lib/parallels-package/build-info-commit.mjs
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
  local _python_bin="$1"
  local log_path="$2"
  node scripts/e2e/lib/parallels-package/log-progress-extract.mjs "$log_path"
}

parallels_bash_seed_workspace_snippet() {
  local purpose="$1"
  cat <<EOF
workspace="\${OPENCLAW_WORKSPACE_DIR:-\$HOME/.openclaw/workspace}"
mkdir -p "\$workspace/.openclaw"
cat > "\$workspace/IDENTITY.md" <<'IDENTITY_EOF'
# Identity

- Name: OpenClaw
- Purpose: $purpose
IDENTITY_EOF
cat > "\$workspace/.openclaw/workspace-state.json" <<'STATE_EOF'
{
  "version": 1,
  "setupCompletedAt": "2026-01-01T00:00:00.000Z"
}
STATE_EOF
rm -f "\$workspace/BOOTSTRAP.md"
EOF
}

parallels_powershell_seed_workspace_snippet() {
  local purpose="$1"
  cat <<EOF
\$workspace = \$env:OPENCLAW_WORKSPACE_DIR
if (-not \$workspace) {
  \$workspace = Join-Path \$env:USERPROFILE '.openclaw\\workspace'
}
\$stateDir = Join-Path \$workspace '.openclaw'
New-Item -ItemType Directory -Path \$stateDir -Force | Out-Null
@'
# Identity

- Name: OpenClaw
- Purpose: $purpose
'@ | Set-Content -Path (Join-Path \$workspace 'IDENTITY.md') -Encoding UTF8
@'
{
  "version": 1,
  "setupCompletedAt": "2026-01-01T00:00:00.000Z"
}
'@ | Set-Content -Path (Join-Path \$stateDir 'workspace-state.json') -Encoding UTF8
Remove-Item (Join-Path \$workspace 'BOOTSTRAP.md') -Force -ErrorAction SilentlyContinue
EOF
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
