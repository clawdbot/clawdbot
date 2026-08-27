#!/usr/bin/env bash
set -euo pipefail

node_version="24.19.0"
pnpm_spec="pnpm@11.22.0+sha512.1ff870c4c6133dfd88fb2afc46dd13d47f09c9794b438c6fdb47ca98caf3bc16381ee0be93a091b8e3824cf01f889f46d7d9e20910fb0be1ab0fb5baa80dd621"

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <expected-head-sha> <command> [args...]" >&2
  exit 2
fi
expected_head_sha="$1"
shift
unset NODE_OPTIONS

imds_token="$(
  /usr/bin/curl -fsS --connect-timeout 2 --max-time 5 -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
    http://169.254.169.254/latest/api/token
)"
iam_status="$(
  /usr/bin/curl -sS --connect-timeout 2 --max-time 5 -o /dev/null -w "%{http_code}" \
    -H "X-aws-ec2-metadata-token: ${imds_token}" \
    http://169.254.169.254/latest/meta-data/iam/security-credentials/
)"
if [[ "$iam_status" != "404" ]]; then
  echo "refusing untrusted bootstrap: IAM credentials endpoint returned ${iam_status}" >&2
  exit 1
fi

actual_head_sha="$(/usr/bin/git rev-parse HEAD)"
if [[ "$actual_head_sha" != "$expected_head_sha" ]]; then
  echo "refusing untrusted run: expected HEAD ${expected_head_sha}, got ${actual_head_sha}" >&2
  exit 1
fi

case "$(/usr/bin/uname -m)" in
  x86_64) node_arch="x64" ;;
  aarch64 | arm64) node_arch="arm64" ;;
  *)
    echo "unsupported architecture: $(/usr/bin/uname -m)" >&2
    exit 2
    ;;
esac

archive="node-v${node_version}-linux-${node_arch}.tar.xz"
base_url="https://nodejs.org/dist/v${node_version}"
install_root="/opt/openclaw-untrusted-node-v${node_version}-${node_arch}"
corepack_home="/opt/openclaw-untrusted-corepack"
tmp_dir="$(/usr/bin/mktemp -d)"
run_home=""
# Invoked by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  /bin/rm -rf -- "$tmp_dir"
  if [[ -n "$run_home" ]]; then
    /bin/rm -rf -- "$run_home"
  fi
}
trap cleanup EXIT

/usr/bin/curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 \
  -o "$tmp_dir/$archive" "$base_url/$archive"
/usr/bin/curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 \
  -o "$tmp_dir/SHASUMS256.txt" "$base_url/SHASUMS256.txt"
(
  cd "$tmp_dir"
  /usr/bin/grep "  ${archive}\$" SHASUMS256.txt | /usr/bin/sha256sum -c -
)

# Only public toolchain artifacts need shared access; keep caller state private.
sudo /bin/bash -s -- "$install_root" "$corepack_home" "$tmp_dir/$archive" "$pnpm_spec" <<'INSTALL'
set -euo pipefail
umask 022
install_root="$1"
corepack_home="$2"
archive_path="$3"
pnpm_spec="$4"
/bin/rm -rf -- "$install_root" "$corepack_home"
/usr/bin/mkdir -p "$install_root" "$corepack_home"
/usr/bin/tar -xJf "$archive_path" -C "$install_root" --strip-components=1
/usr/bin/env \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  COREPACK_HOME="$corepack_home" \
  PATH="$install_root/bin:/usr/bin:/bin" \
  "$install_root/bin/corepack" enable --install-directory "$install_root/bin"
/usr/bin/env \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  COREPACK_HOME="$corepack_home" \
  PATH="$install_root/bin:/usr/bin:/bin" \
  "$install_root/bin/corepack" prepare "$pnpm_spec" --activate
INSTALL

for tool in node npm npx corepack pnpm pnpx; do
  if [[ -e "$install_root/bin/$tool" ]]; then
    sudo /usr/bin/ln -sfn "$install_root/bin/$tool" "/usr/local/bin/$tool"
  fi
done

/usr/local/bin/node --version

actual_package_manager="$(
  /usr/local/bin/node -e \
    'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); process.stdout.write(pkg.packageManager || "")'
)"
if [[ "$actual_package_manager" != "$pnpm_spec" ]]; then
  echo "refusing untrusted run: packageManager pin differs from trusted main" >&2
  exit 1
fi

run_home="$(/usr/bin/mktemp -d)"
export HOME="$run_home"
export COREPACK_HOME="$corepack_home"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
/usr/local/bin/pnpm --version
/usr/local/bin/pnpm install --frozen-lockfile
command_status=0
"$@" || command_status=$?
exit "$command_status"
