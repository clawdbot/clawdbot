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
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const ok =
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) ||
    (major === 24 && minor >= 15) ||
    (major === 25 && minor >= 9) ||
    major >= 26;
  if (!ok) {
    process.stderr.write(`unsupported node ${process.versions.node}\n`);
    process.exit(1);
  }
  let sqliteVersion;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get()?.version;
    } finally {
      db.close();
    }
  } catch {
    process.stderr.write(`unsupported node ${process.versions.node}: missing node:sqlite\n`);
    process.exit(1);
  }
  const match =
    typeof sqliteVersion === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(sqliteVersion) : null;
  const sqliteMajor = Number(match?.[1]);
  const sqliteMinor = Number(match?.[2]);
  const sqlitePatch = Number(match?.[3]);
  const sqliteSafe =
    sqliteMajor > 3 ||
    (sqliteMajor === 3 &&
      (sqliteMinor > 51 ||
        (sqliteMinor === 51 && sqlitePatch >= 3) ||
        (sqliteMinor === 50 && sqlitePatch >= 7) ||
        (sqliteMinor === 44 && sqlitePatch >= 6)));
  if (!sqliteSafe) {
    process.stderr.write(
      `unsupported node ${process.versions.node}: unsafe SQLite ${String(sqliteVersion)}\n`,
    );
    process.exit(1);
  }
'
command -v npm >/dev/null

echo "==> Run installer (non-root user)"
curl -fsSL --connect-timeout 30 --max-time 300 -- "$INSTALL_URL" | bash

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
