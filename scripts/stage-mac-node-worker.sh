#!/usr/bin/env bash
set -euo pipefail

# Called after the canonical source build, before the app is signed. The
# complete npm artifact owns dependency selection; this is not a dist closure.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATION="$1"
shift
[[ "$#" -gt 0 ]] || { echo "ERROR: No worker architectures requested" >&2; exit 1; }
runtime_name=runtime
case "${OPENCLAW_MAC_SIGNING_VARIANT:-standard}" in
  standard) ;;
  elevation-host) runtime_name=elevation ;;
  *) echo "ERROR: Unknown Mac signing variant" >&2; exit 1 ;;
esac
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-mac-worker.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/home" "$STAGE/package"

# Lifecycle hooks must never see operator config, credentials, or state;
# installer main discovers launchd by UID even with a new HOME.
# Use the build's pinned pnpm packer, not the host npm's expanding file globs.
TARBALL="$(env -i HOME="$STAGE/home" PATH="$PATH" TMPDIR="$STAGE" \
  node "$ROOT_DIR/scripts/package-openclaw-for-docker.mjs" \
  --skip-build --pnpm-pack --allow-unreleased-changelog --output-dir "$STAGE/package" \
  --output-name openclaw.tgz)"
[[ -f "$TARBALL" ]] || { echo "ERROR: Canonical worker package missing" >&2; exit 1; }

for arch in "$@"; do
  case "$arch" in
    arm64) node_arch=arm64 ;;
    x86_64) node_arch=x64 ;;
    *) echo "ERROR: Unsupported Mac worker architecture: $arch" >&2; exit 1 ;;
  esac
  mkdir -p "$STAGE/$arch/home" "$STAGE/$arch/tmp"
  env -i HOME="$STAGE/$arch/home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    TMPDIR="$STAGE/$arch/tmp" OPENCLAW_INSTALL_CLI_SH_NO_RUN=1 \
    bash -c '
      set -euo pipefail
      source "$1/scripts/install-cli.sh"
      PREFIX="$2/prefix"
      OPENCLAW_VERSION="$3"
      install_node darwin "$4"
      export PATH="$(node_dir)/bin:$PATH"
      "$(node_bin)" -e '\''if (process.arch !== process.argv[1]) process.exit(1)'\'' "$4" || {
        echo "ERROR: Cannot execute requested Node architecture $4; x64 on ARM requires Rosetta" >&2
        exit 1
      }
      install_openclaw
      mv "$(node_dir)" "$2/runtime"
    ' bash "$ROOT_DIR" "$STAGE/$arch" "$TARBALL" "$node_arch"
  if [[ "$runtime_name" == elevation ]]; then
    env -i HOME="$STAGE/$arch/home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
      TMPDIR="$STAGE/$arch/tmp" /usr/bin/python3 -B "$ROOT_DIR/scripts/materialize-mac-node-worker.py" \
      "$STAGE/$arch/runtime" "$STAGE/$arch/elevation" "$STAGE/$arch" "$arch"
  fi
  # Validate after moving out of its install prefix: absolute wrappers/symlinks
  # cannot accidentally make a non-relocatable payload pass the proof.
  env -i HOME="$STAGE/$arch/home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    TMPDIR="$STAGE/$arch/tmp" \
    "$STAGE/$arch/$runtime_name/bin/node" "$ROOT_DIR/scripts/verify-mac-node-worker.mjs" \
    "$STAGE/$arch/$runtime_name" "$ROOT_DIR/dist/build-info.json"
done

mkdir -p "$DESTINATION"
# The packager owns this private parent; reject every occupant before any move.
for arch in "$@"; do
  [[ ! -e "$DESTINATION/$arch" && ! -L "$DESTINATION/$arch" ]] || { echo "ERROR: Worker destination exists: $DESTINATION/$arch" >&2; exit 1; }
done
for arch in "$@"; do
  mv "$STAGE/$arch/$runtime_name" "$DESTINATION/$arch"
done
