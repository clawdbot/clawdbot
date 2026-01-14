#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${CLAWDBOT_INSTALL_URL:-https://clawd.bot/install.sh}"
SMOKE_PREVIOUS_VERSION="${CLAWDBOT_INSTALL_SMOKE_PREVIOUS:-}"
SKIP_PREVIOUS="${CLAWDBOT_INSTALL_SMOKE_SKIP_PREVIOUS:-0}"

echo "==> Resolve npm versions"
LATEST_VERSION="$(npm view clawdbot version)"
if [[ -n "$SMOKE_PREVIOUS_VERSION" ]]; then
  PREVIOUS_VERSION="$SMOKE_PREVIOUS_VERSION"
else
  PREVIOUS_VERSION="$(node - <<'NODE'
const { execSync } = require("node:child_process");

const versions = JSON.parse(execSync("npm view clawdbot versions --json", { encoding: "utf8" }));
if (!Array.isArray(versions) || versions.length === 0) {
  process.exit(1);
}
const previous = versions.length >= 2 ? versions[versions.length - 2] : versions[0];
process.stdout.write(previous);
NODE
)"
fi

echo "latest=$LATEST_VERSION previous=$PREVIOUS_VERSION"

if [[ "$SKIP_PREVIOUS" == "1" ]]; then
  echo "==> Skip preinstall previous (CLAWDBOT_INSTALL_SMOKE_SKIP_PREVIOUS=1)"
else
  echo "==> Preinstall previous (forces installer upgrade path)"
  npm install -g "clawdbot@${PREVIOUS_VERSION}"
fi

echo "==> Run official installer one-liner"
curl -fsSL "$INSTALL_URL" | bash

echo "==> Verify installed version"
INSTALLED_VERSION="$(clawdbot --version 2>/dev/null | head -n 1 | tr -d '\r')"
echo "installed=$INSTALLED_VERSION expected=$LATEST_VERSION"

if [[ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]]; then
  echo "ERROR: expected clawdbot@$LATEST_VERSION, got clawdbot@$INSTALLED_VERSION" >&2
  exit 1
fi

echo "==> Sanity: CLI runs"
clawdbot --help >/dev/null

echo "OK"
