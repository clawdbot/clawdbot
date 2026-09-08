#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Updates a self-hosted OpenClaw gateway that runs from this source checkout.
#
# Reference workflow for team-operated servers (see docs/install/updating.md).
# Simple installs should prefer `openclaw update` / `openclaw update --channel
# dev`; this script exists for checkouts that additionally need to:
#   - preserve a local branch by rebasing it onto origin/main,
#   - refuse all tracked local changes, including build outputs,
#   - build clean (incremental builds have shipped stale hashed chunks),
#   - restart a custom service unit.
#
# Environment:
#   OPENCLAW_UPDATE_RESTART_CMD  restart command (default: openclaw gateway restart)
#                                set to "" to skip the restart step
#   OPENCLAW_UPDATE_REMOTE       git remote to update from (default: origin)
set -euo pipefail

pnpm_dir=""
log() { echo "[update-gateway] $*"; }
on_exit() {
  local code=$?
  if [ -n "$pnpm_dir" ]; then rm -rf "$pnpm_dir"; fi
  if [ "$code" -ne 0 ]; then
    echo "[update-gateway] FAILED (exit $code)" >&2
  fi
}
trap on_exit EXIT

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Create private shims before fetching; target compatibility needs an invocation
# after fetch, before checkout mutation. Never activate a global version.
if ! command -v corepack >/dev/null 2>&1; then
  log "Corepack is required. Install a Corepack version compatible with the target pnpm pin, then retry."
  exit 1
fi
pnpm_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-pnpm.XXXXXX")"
if ! corepack enable --install-directory "$pnpm_dir" pnpm || [ ! -x "$pnpm_dir/pnpm" ]; then
  log "Corepack could not create scoped pnpm shims. Repair Corepack before retrying; no Git update was attempted."
  exit 1
fi
run_pnpm() (
  # Source updates own downloads; do not wait for a Corepack terminal prompt.
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  export PATH="$pnpm_dir:$PATH"
  export NPM_CONFIG_WORKSPACE_DIR="$PWD" npm_config_workspace_dir="$PWD"
  export PNPM_CONFIG_LOCKFILE_DIR="$PWD" pnpm_config_lockfile_dir="$PWD"
  "$pnpm_dir/pnpm" "$@"
)

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
# outputs: build and check tooling regenerates them, tracked or not — never
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

# Probe only package-manager metadata, not target dependencies or hooks. Freeze
# the fetched commit so the probe and later checkout update cannot drift apart.
probe_dir="$pnpm_dir/probe"
if ! target_sha="$(git rev-parse --verify 'FETCH_HEAD^{commit}')" ||
  ! target_version="$(git show "$target_sha:package.json" | node -e '
    const fs = require("node:fs");
    const pin = JSON.parse(fs.readFileSync(0, "utf8")).packageManager;
    const version = typeof pin === "string" && /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/.exec(pin);
    if (!version) throw new Error("Fetched package.json must declare an exact pnpm packageManager pin");
    const dir = process.argv[1];
    fs.mkdirSync(dir);
    fs.writeFileSync(dir + "/package.json", JSON.stringify({private: true, packageManager: pin}));
    fs.writeFileSync(dir + "/pnpm-workspace.yaml", "packages: []\n");
    process.stdout.write(version[1]);
  ' "$probe_dir")" ||
  ! probe_version="$(cd "$probe_dir" && run_pnpm --version)" ||
  [ "$probe_version" != "$target_version" ]; then
  log "Target pnpm preflight failed; no checkout update or restart was attempted. Verify the fetched packageManager pin and install a compatible Corepack, then retry."
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "main" ]; then
  log "fast-forwarding main"
  git merge --ff-only "$target_sha"
else
  # A server may carry a local branch (e.g. an agent's in-progress fix) on top
  # of main. Rebase preserves that work while still deploying latest main;
  # --rebase-merges keeps merge commits (and their conflict resolutions)
  # instead of silently flattening them away.
  log "rebasing local branch '$branch' onto ${remote}/main"
  if ! git rebase --rebase-merges "$target_sha"; then
    git rebase --abort
    log "rebase of '$branch' conflicts with ${remote}/main; resolve manually"
    exit 1
  fi
fi

log "installing dependencies"
run_pnpm install --frozen-lockfile

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
# The build owns cleanup under its checkout-local artifact lock. Deleting here
# would race declaration writers and readers before that ownership is acquired.
# Match CLI updates: build runtime artifacts unless declarations were explicitly requested.
OPENCLAW_UPDATE_IN_PROGRESS=1 run_pnpm build

restart_cmd="${OPENCLAW_UPDATE_RESTART_CMD-openclaw gateway restart}"
if [ -n "$restart_cmd" ]; then
  log "restarting gateway: $restart_cmd"
  bash -c "$restart_cmd"
else
  log "restart skipped (OPENCLAW_UPDATE_RESTART_CMD is empty)"
fi

log "OK $(git rev-parse --short HEAD) ($branch)"
