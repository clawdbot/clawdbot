#!/usr/bin/env bash
set -euo pipefail
recorder_user="$(id -un)"
sudo useradd --create-home --shell /bin/bash codex
{
  printf '%s\n' 'Defaults env_keep += "CODEX_HOME CODEX_INTERNAL_ORIGINATOR_OVERRIDE"'
  printf '%s\n' 'codex ALL=(mantis-sut) NOPASSWD: /usr/local/lib/mantis-toolchain/telegram-mantis-lane'
  printf '%s\n' 'mantis-sut ALL=(root) NOPASSWD: /usr/local/sbin/openclaw-mantis-sut-container'
  printf '%s\n' "mantis-sut ALL=(${recorder_user}) NOPASSWD: /usr/local/lib/mantis-toolchain/telegram-desktop-recorder"
  printf '%s\n' "mantis-sut ALL=(${recorder_user}) NOPASSWD: /usr/local/lib/mantis-toolchain/telegram-user-driver"
} | sudo tee /etc/sudoers.d/mantis-codex >/dev/null
sudo chmod 0440 /etc/sudoers.d/mantis-codex

make_bridge() {
  local lane="$1"
  local repo_root="$2"
  local target="${RUNNER_TEMP}/mantis-telegram-${lane}"
  cat >"$target" <<EOF
#!/usr/bin/env bash
set -euo pipefail
command="\${1:-}"
test -n "\$command"
shift
if [[ "\$command" == start ]]; then
  exec /usr/local/bin/openclaw-telegram-mantis-lane start --lane ${lane} --repo-root ${repo_root@Q} "\$@"
fi
exec /usr/local/bin/openclaw-telegram-mantis-lane "\$command" --lane ${lane} "\$@"
EOF
  sudo install -m 0555 "$target" "/usr/local/bin/mantis-telegram-${lane}"
}
make_bridge baseline "$BASELINE_ROOT"
make_bridge candidate "$CANDIDATE_ROOT"

codex_home="/tmp/mantis-codex-home-${GITHUB_RUN_ID}"
sudo install -d -m 0770 -o codex -g codex "$codex_home"
sudo setfacl -m "u:${recorder_user}:rwx,u:codex:rwx" "$codex_home"
sudo setfacl -d -m "u:${recorder_user}:rwx,u:codex:rwx" "$codex_home"

output_root="$GITHUB_WORKSPACE/$MANTIS_OUTPUT_DIR"
sudo install -d -m 2770 -o root -g mantis-proof "$output_root"
sudo setfacl -m "u:${recorder_user}:rwx,u:codex:rwx,u:mantis-sut:rwx" "$output_root"
sudo setfacl -d -m "u:${recorder_user}:rwx,u:codex:rwx,u:mantis-sut:rwx" "$output_root"

session_root="$SESSION_ROOT"
fixture_root="$session_root/fixture-plugins"
sudo setfacl -m u:codex:--x "$session_root"
sudo install -d -m 0710 -o root -g mantis-proof "$fixture_root"
sudo setfacl -m u:codex:--x "$fixture_root"
for lane in baseline candidate; do
  sudo install -d -m 2770 -o codex -g mantis-proof "$fixture_root/$lane"
  sudo setfacl -m u:mantis-sut:rwx "$fixture_root/$lane"
  sudo setfacl -d -m u:codex:rwx,u:mantis-sut:rwx "$fixture_root/$lane"
done

workspace_parent="$(dirname "$GITHUB_WORKSPACE")"
while [[ "$workspace_parent" != / ]]; do
  sudo setfacl -m u:codex:--x,u:mantis-sut:--x "$workspace_parent"
  [[ "$workspace_parent" == /home/runner ]] && break
  workspace_parent="$(dirname "$workspace_parent")"
done
sudo setfacl -m u:codex:rx "$GITHUB_WORKSPACE"

worktree_root="/tmp/openclaw-mantis-proof-worktrees-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
sudo chown -R root:root "$worktree_root"
sudo find "$worktree_root" -xdev ! -type l -perm /222 -exec chmod a-w {} +
sudo chmod -R a+rX "$worktree_root"
sudo chmod 0755 "$worktree_root"
