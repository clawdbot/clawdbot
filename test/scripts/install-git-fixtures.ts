export function createInstallGitCommitFixtureScript(source: "bundle" | "remote") {
  return `
    set -euo pipefail
    source "$OPENCLAW_INSTALLER_SCRIPT"
    run_quiet_step() { shift; "$@"; }
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    seed="$tmp/seed"
    repo="$tmp/repo"
    git init -q --initial-branch=main "$seed"
    git -C "$seed" config user.email test@example.invalid
    git -C "$seed" config user.name test
    printf 'base\\n' > "$seed/state.txt"
    git -C "$seed" add state.txt
    git -C "$seed" commit -qm base
    base="$(git -C "$seed" rev-parse HEAD)"
    git -C "$seed" bundle create "$tmp/source.bundle" HEAD
    git clone -q "$tmp/source.bundle" "$repo"
    selected="$base"
    if [[ "${source}" == remote ]]; then
      git init --bare -q "$tmp/remote.git"
      git -C "$seed" remote add origin "$tmp/remote.git"
      printf 'selected\\n' > "$seed/state.txt"
      git -C "$seed" commit -qam selected
      selected="$(git -C "$seed" rev-parse HEAD)"
      git -C "$seed" update-ref "refs/heads/$selected" "$base"
      git -C "$seed" push -q origin main "refs/heads/$selected"
      git -C "$repo" remote set-url origin "$tmp/remote.git"
      if git -C "$repo" cat-file -e "$selected" 2>/dev/null; then
        echo "fixture already has the requested commit"
        exit 1
      fi
    fi
    GIT_UPDATE=0
    checkout_git_openclaw_ref "$repo" "$selected"
    [[ "$(git -C "$repo" rev-parse HEAD)" == "$selected" ]]
    [[ -z "$(git -C "$repo" symbolic-ref --quiet HEAD || true)" ]]
    [[ "$GIT_REF_KIND" == immutable ]]
    [[ "$(git_install_lockfile_flag "$GIT_REF_KIND")" == --frozen-lockfile ]]
    printf 'selected=%s kind=%s\\n' "$selected" "$GIT_REF_KIND"
    blob="$(git -C "$repo" rev-parse HEAD:state.txt)"
    for rejected in "$blob" 0000000000000000000000000000000000000001 'HEAD~1'; do
      if (checkout_git_openclaw_ref "$repo" "$rejected") >"$tmp/rejected.log" 2>&1; then
        cat "$tmp/rejected.log"
        echo "unexpectedly accepted $rejected"
        exit 1
      fi
      [[ -s "$tmp/rejected.log" ]]
      [[ "$(git -C "$repo" rev-parse HEAD)" == "$selected" ]]
      [[ -z "$(git -C "$repo" status --porcelain)" ]]
      printf 'rejected=%s\\n' "$rejected"
    done
  `;
}
