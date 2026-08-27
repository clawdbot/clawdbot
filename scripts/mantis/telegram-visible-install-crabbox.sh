#!/usr/bin/env bash
set -euo pipefail
test "$(uname -m)" = x86_64
install_dir="${RUNNER_TEMP}/crabbox"
archive="$install_dir/crabbox.tar.gz"
mkdir -p "$install_dir"
curl --fail --location --silent --show-error \
  --connect-timeout 15 --max-time 120 --retry 3 --retry-all-errors \
  --output "$archive" \
  "https://github.com/openclaw/crabbox/releases/download/v${CRABBOX_VERSION}/crabbox_${CRABBOX_VERSION}_linux_amd64.tar.gz"
printf '%s  %s\n' "$CRABBOX_LINUX_AMD64_SHA256" "$archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$install_dir" crabbox
sudo install -m 0755 "$install_dir/crabbox" /usr/local/bin/crabbox
test "$(crabbox --version)" = "$CRABBOX_VERSION"
crabbox media preview --help >/dev/null
