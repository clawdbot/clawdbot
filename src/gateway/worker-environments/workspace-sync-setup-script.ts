export const REMOTE_WORKSPACE_SETUP_SCRIPT = String.raw`set -eu
relative=$1
canonical_home=$(cd "$HOME" && pwd -P)

ensure_private_directory() {
  directory=$1
  if [ -e "$directory" ] || [ -L "$directory" ]; then
    if [ ! -d "$directory" ] || [ -L "$directory" ]; then
      printf '%s\n' 'unsafe worker workspace directory' >&2
      exit 2
    fi
  else
    mkdir "$directory"
  fi
  chmod 700 "$directory"
}

current=$canonical_home
old_ifs=$IFS
IFS=/
set -- $relative
IFS=$old_ifs
for segment in "$@"; do
  current=$current/$segment
  ensure_private_directory "$current"
done
cd "$current"
find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
canonical_workspace=$(pwd -P)
node -e 'process.stdout.write(JSON.stringify({tag:"openclaw-workspace-setup-v1",canonicalHome:process.argv[1],canonicalWorkspace:process.argv[2]})+"\n")' "$canonical_home" "$canonical_workspace"
`;
