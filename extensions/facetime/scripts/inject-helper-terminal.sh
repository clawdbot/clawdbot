#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "cd ${repo_root//\"/\\\"} && pnpm inject:helper && pnpm inject:helper:phone; echo; echo FaceTime and Phone helper injection finished"
end tell
APPLESCRIPT
