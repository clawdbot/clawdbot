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
#                                set to "" to skip the restart step
#   OPENCLAW_UPDATE_REMOTE       git remote to update from (default: origin)
set -euo pipefail

log() { echo "[update-gateway] $*"; }
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "[update-gateway] FAILED (exit $code)" >&2
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

# `pnpm build` rewrites this tracked bundle, which would make the tree look
# dirty and block the rebase below. Restoring it loses nothing: the build
# regenerates it from source every run.
git checkout -- extensions/browser/chrome-extension/modules/copilot-runtime.js 2>/dev/null || true

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
# the previous revision in dist; a clean build is the reliable path.
log "clean building"
# These deletes must stay inside the checkout: a symlinked build dir would
# redirect the recursion into its target, so refuse symlinks outright.
for build_path in dist dist-runtime .artifacts; do
  if [ -L "$build_path" ]; then
    log "$build_path is a symlink; refusing to clean through it"
    exit 1
  fi
done
rm -rf dist dist-runtime .artifacts/tsgo-cache
pnpm build

restart_cmd="${OPENCLAW_UPDATE_RESTART_CMD-openclaw gateway restart}"
if [ -n "$restart_cmd" ]; then
  log "restarting gateway: $restart_cmd"
  bash -c "$restart_cmd"
else
  log "restart skipped (OPENCLAW_UPDATE_RESTART_CMD is empty)"
fi

log "OK $(git rev-parse --short HEAD) ($branch)"
