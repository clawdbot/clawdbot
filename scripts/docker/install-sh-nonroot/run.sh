#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
DEFAULT_PACKAGE="openclaw"
PACKAGE_NAME="${OPENCLAW_INSTALL_PACKAGE:-$DEFAULT_PACKAGE}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=../install-sh-common/cli-verify.sh
source "$SCRIPT_DIR/../install-sh-common/cli-verify.sh"

echo "==> Pre-flight: ensure git absent"
if command -v git >/dev/null; then
  echo "git is present unexpectedly" >&2
  exit 1
fi

echo "==> Pre-flight: ensure supported Node is already present"
node -e '
  const version = process.versions.node.split(".").map(Number);
  const ok =
    version.length >= 2 &&
    (version[0] > 22 || (version[0] === 22 && version[1] >= 16));
  if (!ok) {
    process.stderr.write(`unsupported node ${process.versions.node}\n`);
    process.exit(1);
  }
'
command -v npm >/dev/null

echo "==> Run installer (non-root user)"
curl -fsSL "$INSTALL_URL" | bash

# Ensure PATH picks up user npm prefix
export PATH="$HOME/.npm-global/bin:$PATH"

echo "==> Verify git installed"
command -v git >/dev/null

EXPECTED_VERSION="${OPENCLAW_INSTALL_EXPECT_VERSION:-}"
if [[ -n "$EXPECTED_VERSION" ]]; then
  LATEST_VERSION="$EXPECTED_VERSION"
else
  LATEST_VERSION="$(quiet_npm view "$PACKAGE_NAME" version)"
fi
echo "==> Verify CLI installed"
verify_installed_cli "$PACKAGE_NAME" "$LATEST_VERSION"

echo "OK"
