#!/usr/bin/env bash
# Updates a self-hosted OpenClaw gateway that runs from this source checkout.
#
# Reference workflow for team-operated servers (see docs/install/updating.md).
# Simple installs should prefer `openclaw update` / `openclaw update --channel
# dev`; this script exists for checkouts that additionally need to:
#   - preserve a local branch by rebasing it onto origin/main,
#   - tolerate tracked build outputs that `pnpm build` rewrites,
#   - build clean (incremental builds have shipped stale hashed chunks),
#   - restart a custom service unit.
#
# Environment:
#   OPENCLAW_UPDATE_RESTART_CMD  restart command (default: openclaw gateway restart)
#   OPENCLAW_UPDATE_STOP_CMD     stop command run before replacing live build output
#                                (default: openclaw gateway stop --force)
#                                custom stop/restart commands must be set together
#   OPENCLAW_UPDATE_REMOTE       git remote to update from (default: origin)
set -euo pipefail

log() { echo "[update-gateway] $*"; }

trim_command() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

restart_override_set=0
stop_override_set=0
[[ -v OPENCLAW_UPDATE_RESTART_CMD ]] && restart_override_set=1
[[ -v OPENCLAW_UPDATE_STOP_CMD ]] && stop_override_set=1
if [ "$restart_override_set" -ne "$stop_override_set" ]; then
  echo "[update-gateway] OPENCLAW_UPDATE_STOP_CMD and OPENCLAW_UPDATE_RESTART_CMD must be set together" >&2
  exit 1
fi
if [ "$restart_override_set" -eq 1 ]; then
  restart_cmd="$(trim_command "$OPENCLAW_UPDATE_RESTART_CMD")"
  stop_cmd="$(trim_command "$OPENCLAW_UPDATE_STOP_CMD")"
else
  restart_cmd="openclaw gateway restart"
  # --force: gateway stop refuses non-interactive runs without it, and this
  # script's documented entry point is non-interactive (ssh ... update-gateway.sh).
  stop_cmd="openclaw gateway stop --force"
fi
if [ -z "$restart_cmd" ]; then
  echo "[update-gateway] OPENCLAW_UPDATE_RESTART_CMD is blank; refusing to replace live build output without a restart path" >&2
  exit 1
fi
if [ -z "$stop_cmd" ]; then
  echo "[update-gateway] OPENCLAW_UPDATE_STOP_CMD is blank; refusing to replace live build output without stopping the gateway" >&2
  exit 1
fi

gateway_stopped=0
build_backup=""
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    if [ -n "$build_backup" ] && [ -d "$build_backup" ]; then
      log "restoring previous build output"
      rm -rf dist dist-runtime
      [ ! -d "$build_backup/dist" ] || mv "$build_backup/dist" dist
      [ ! -d "$build_backup/dist-runtime" ] || mv "$build_backup/dist-runtime" dist-runtime
    fi
    if [ "$gateway_stopped" -eq 1 ] && [ -n "$restart_cmd" ]; then
      log "restarting gateway on previous build after update failure"
      bash -c "$restart_cmd" || true
    fi
    echo "[update-gateway] FAILED (exit $code)" >&2
  fi
  if [ -n "$build_backup" ] && [ -d "$build_backup" ]; then
    rm -rf "$build_backup"
  fi
}
trap on_exit EXIT

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

remote="${OPENCLAW_UPDATE_REMOTE:-origin}"

# Never update over an in-progress git operation: aborting or rebasing on top
# of an operator's paused rebase/merge would discard their progress.
git_dir="$(git rev-parse --git-dir)"
if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] || \
  [ -f "$git_dir/MERGE_HEAD" ] || [ -f "$git_dir/CHERRY_PICK_HEAD" ]; then
  log "a git rebase/merge/cherry-pick is in progress; finish or abort it first"
  exit 1
fi

# Fail closed on any other local changes: an agent or operator may have
# uncommitted work in this checkout, and an update must never eat it.
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "working tree has local changes; commit, stash, or restore them first:"
  status_lines="$(git status --short)"
  head -20 <<<"$status_lines"
  exit 1
fi

# dist, dist-runtime, and .artifacts/tsgo-cache are wholly disposable build
# outputs: every update deletes and regenerates them, tracked or not — never
# store anything there. Untracked files elsewhere are kept and only warned
# about (servers accumulate harmless scratch files). Accepted tradeoff: an
# untracked file a build tool happens to read stays in effect, same as before
# the update; operators own what they leave in the checkout.
untracked="$(git ls-files --others --exclude-standard)"
if [ -n "$untracked" ]; then
  log "warning: untracked files present; they are kept and a build tool that reads them can affect the deployed output:"
  head -10 <<<"$untracked"
fi

log "fetching ${remote}/main"
git fetch "$remote" main

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "main" ]; then
  log "fast-forwarding main"
  git merge --ff-only "${remote}/main"
else
  # A server may carry a local branch (e.g. an agent's in-progress fix) on top
  # of main. Rebase preserves that work while still deploying latest main;
  # --rebase-merges keeps merge commits (and their conflict resolutions)
  # instead of silently flattening them away.
  log "rebasing local branch '$branch' onto ${remote}/main"
  if ! git rebase --rebase-merges "${remote}/main"; then
    git rebase --abort
    log "rebase of '$branch' conflicts with ${remote}/main; resolve manually"
    exit 1
  fi
fi

log "installing dependencies"
pnpm install --frozen-lockfile

# Incremental builds have left stale hashed chunks and config validators from
# the previous revision in dist; a clean build is the reliable path. A running
# gateway dynamically imports hashed chunks, so stop it before moving or
# rebuilding dist. Keep the old output until the new build succeeds so a failed
# compile can restore service instead of leaving the gateway unbootable.
log "clean building"
# These deletes must stay inside the checkout: a symlinked build dir would
# redirect the recursion into its target, so refuse symlinks outright.
for build_path in dist dist-runtime .artifacts; do
  if [ -L "$build_path" ]; then
    log "$build_path is a symlink; refusing to clean through it"
    exit 1
  fi
done

log "stopping gateway before replacing hashed build chunks: $stop_cmd"
bash -c "$stop_cmd"
gateway_stopped=1

build_backup="$(mktemp -d "$repo_root/.update-build-backup.XXXXXX")"
[ ! -d dist ] || mv dist "$build_backup/dist"
[ ! -d dist-runtime ] || mv dist-runtime "$build_backup/dist-runtime"
rm -rf .artifacts/tsgo-cache
pnpm build

log "restarting gateway: $restart_cmd"
bash -c "$restart_cmd"
gateway_stopped=0
rm -rf "$build_backup"
build_backup=""

log "OK $(git rev-parse --short HEAD) ($branch)"
