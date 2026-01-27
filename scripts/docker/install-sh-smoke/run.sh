#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${CLAWDBOT_INSTALL_URL:-https://molt.bot/install.sh}"
SMOKE_PREVIOUS_VERSION="${CLAWDBOT_INSTALL_SMOKE_PREVIOUS:-}"
SKIP_PREVIOUS="${CLAWDBOT_INSTALL_SMOKE_SKIP_PREVIOUS:-0}"

echo "==> Resolve npm versions"
if [[ -n "$SMOKE_PREVIOUS_VERSION" ]]; then
  LATEST_VERSION="$(npm view moltbot version)"
  PREVIOUS_VERSION="$SMOKE_PREVIOUS_VERSION"
else
  VERSIONS_JSON="$(npm view moltbot versions --json)"
  versions_line="$(node - <<'NODE'
const raw = process.env.VERSIONS_JSON || "[]";
let versions;
try {
  versions = JSON.parse(raw);
} catch {
  versions = raw ? [raw] : [];
}
if (!Array.isArray(versions)) {
  versions = [versions];
}
if (versions.length === 0) {
  process.exit(1);
}
const latest = versions[versions.length - 1];
const previous = versions.length >= 2 ? versions[versions.length - 2] : latest;
process.stdout.write(`${latest} ${previous}`);
NODE
)"
  LATEST_VERSION="${versions_line%% *}"
  PREVIOUS_VERSION="${versions_line#* }"
fi

if [[ -n "${CLAWDBOT_INSTALL_LATEST_OUT:-}" ]]; then
  printf "%s" "$LATEST_VERSION" > "$CLAWDBOT_INSTALL_LATEST_OUT"
fi

echo "latest=$LATEST_VERSION previous=$PREVIOUS_VERSION"

if [[ "$SKIP_PREVIOUS" == "1" ]]; then
  echo "==> Skip preinstall previous (CLAWDBOT_INSTALL_SMOKE_SKIP_PREVIOUS=1)"
else
  echo "==> Preinstall previous (forces installer upgrade path)"
  npm install -g "moltbot@${PREVIOUS_VERSION}"
fi

echo "==> Run official installer one-liner"
curl -fsSL "$INSTALL_URL" | bash

echo "==> Verify installed version"
INSTALLED_VERSION="$(moltbot --version 2>/dev/null | head -n 1 | tr -d '\r')"
echo "installed=$INSTALLED_VERSION expected=$LATEST_VERSION"

if [[ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]]; then
  echo "ERROR: expected moltbot@$LATEST_VERSION, got moltbot@$INSTALLED_VERSION" >&2
  exit 1
fi

echo "==> Sanity: CLI runs"
moltbot --help >/dev/null

echo "OK"
