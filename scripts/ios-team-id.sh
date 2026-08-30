#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-team-id.sh [--require-canonical]

Prints an Apple Developer Team ID for iOS signing.

Default behavior:
- return IOS_DEVELOPMENT_TEAM when set
- prefer the canonical OpenClaw iOS team when available in Xcode
- otherwise fall back to a local Xcode team for local development builds

Options:
  --require-canonical  fail unless the resolved team is FWJYW4S8P8
EOF
}

canonical_team="FWJYW4S8P8"
require_canonical="0"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-canonical)
      require_canonical="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

canonical_team="${canonical_team//$'\r'/}"

if [[ -n "${IOS_DEVELOPMENT_TEAM:-}" ]]; then
  explicit_team="${IOS_DEVELOPMENT_TEAM//$'\r'/}"
  if [[ "$require_canonical" == "1" && "$explicit_team" != "$canonical_team" ]]; then
    echo "Resolved iOS Team ID '${explicit_team}' is not the canonical OpenClaw iOS team '${canonical_team}'." >&2
    exit 1
  fi
  printf '%s\n' "$explicit_team"
  exit 0
fi

preferred_team="${IOS_PREFERRED_TEAM_ID:-}"
preferred_team_name="${IOS_PREFERRED_TEAM_NAME:-}"
allow_keychain_fallback="${IOS_ALLOW_KEYCHAIN_TEAM_FALLBACK:-0}"
prefer_non_free_team="${IOS_PREFER_NON_FREE_TEAM:-1}"
preferred_team="${preferred_team//$'\r'/}"
preferred_team_name="${preferred_team_name//$'\r'/}"

declare -a team_ids=()
declare -a team_is_free=()
declare -a team_names=()
python_cmd=""

detect_python() {
  local candidate
  for candidate in "${IOS_PYTHON_BIN:-}" python3 python /usr/bin/python3; do
    [[ -n "$candidate" ]] || continue
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

python_cmd="$(detect_python || true)"

append_team() {
  local candidate_id="$1"
  local candidate_is_free="$2"
  local candidate_name="$3"
  candidate_id="${candidate_id//$'\r'/}"
  candidate_is_free="${candidate_is_free//$'\r'/}"
  candidate_name="${candidate_name//$'\r'/}"
  [[ -z "$candidate_id" ]] && return

  local i
  for i in "${!team_ids[@]}"; do
    if [[ "${team_ids[$i]}" == "$candidate_id" ]]; then
      return
    fi
  done

  team_ids+=("$candidate_id")
  team_is_free+=("$candidate_is_free")
  team_names+=("$candidate_name")
}

load_teams_from_xcode_team_key() {
  local key="$1"
  local plist_path="${HOME}/Library/Preferences/com.apple.dt.Xcode.plist"
  [[ -f "$plist_path" ]] || return 0
  [[ -n "$python_cmd" ]] || return 0

  while IFS=$'\t' read -r team_id is_free team_name; do
    [[ -z "$team_id" ]] && continue
    append_team "$team_id" "${is_free:-0}" "${team_name:-}"
  done < <(
    plutil -extract "$key" json -o - "$plist_path" 2>/dev/null \
      | "$python_cmd" -c '
import json
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)

if not isinstance(data, dict):
    raise SystemExit(0)

for teams in data.values():
    if not isinstance(teams, list):
        continue
    for team in teams:
        if not isinstance(team, dict):
            continue
        team_id = str(team.get("teamID", "")).strip()
        if not team_id:
            continue
        is_free = "1" if bool(team.get("isFreeProvisioningTeam", False)) else "0"
        team_name = str(team.get("teamName", "")).replace("\t", " ").strip()
        print(f"{team_id}\t{is_free}\t{team_name}")
'
  )
}

load_teams_from_xcode_preferences() {
  load_teams_from_xcode_team_key IDEProvisioningTeamByIdentifier
  load_teams_from_xcode_team_key IDEProvisioningTeams
}

load_teams_from_legacy_defaults_key() {
  while IFS= read -r team; do
    [[ -z "$team" ]] && continue
    append_team "$team" "0" ""
  done < <(
    defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers 2>/dev/null \
      | grep -Eo '[A-Z0-9]{10}' || true
  )
}

load_teams_from_xcode_managed_profiles() {
  local profiles_dir="${HOME}/Library/MobileDevice/Provisioning Profiles"
  [[ -d "$profiles_dir" ]] || return 0
  [[ -n "$python_cmd" ]] || return 0

  while IFS= read -r team; do
    [[ -z "$team" ]] && continue
    append_team "$team" "0" ""
  done < <(
    for p in "${profiles_dir}"/*.mobileprovision; do
      [[ -f "$p" ]] || continue
      security cms -D -i "$p" 2>/dev/null \
        | "$python_cmd" -c '
import plistlib, sys
try:
    raw = sys.stdin.buffer.read()
    if not raw:
        raise SystemExit(0)
    d = plistlib.loads(raw)
    for tid in d.get("TeamIdentifier", []):
        print(tid)
except Exception:
    pass
' 2>/dev/null
    done | sort -u
  )
}

has_xcode_account() {
  local plist_path="${HOME}/Library/Preferences/com.apple.dt.Xcode.plist"
  [[ -f "$plist_path" ]] || return 1
  local accts
  accts="$(defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists 2>/dev/null || true)"
  [[ -n "$accts" ]] && [[ "$accts" != *"does not exist"* ]] && grep -q 'identifier' <<< "$accts"
}

load_teams_from_xcode_preferences
load_teams_from_legacy_defaults_key

if [[ ${#team_ids[@]} -eq 0 ]]; then
  load_teams_from_xcode_managed_profiles
fi

if [[ ${#team_ids[@]} -eq 0 && "$allow_keychain_fallback" == "1" ]]; then
  while IFS= read -r team; do
    [[ -z "$team" ]] && continue
    append_team "$team" "0" ""
  done < <(
    security find-identity -p codesigning -v 2>/dev/null \
      | grep -Eo '\([A-Z0-9]{10}\)' \
      | tr -d '()' || true
  )
fi

if [[ ${#team_ids[@]} -eq 0 ]]; then
  if [[ "$require_canonical" == "1" ]]; then
    echo "Canonical OpenClaw iOS Team ID '${canonical_team}' is not available in Xcode on this machine." >&2
    echo "Sign into the Apple Developer account that owns the canonical team, or set IOS_DEVELOPMENT_TEAM=${canonical_team}." >&2
    exit 1
  fi

  if has_xcode_account; then
    echo "An Apple account is signed in to Xcode, but no Team ID could be resolved." >&2
    echo "" >&2
    echo "On Xcode 16+, team data is not written until you build a project." >&2
    echo "To fix this, do ONE of the following:" >&2
    echo "" >&2
    echo "  1. Open the iOS project in Xcode, select your Team in Signing &" >&2
    echo "     Capabilities, and build once. Then re-run this script." >&2
    echo "" >&2
    echo "  2. Set your Team ID directly:" >&2
    echo "       export IOS_DEVELOPMENT_TEAM=<your-10-char-team-id>" >&2
    echo "     Find your Team ID at: https://developer.apple.com/account#MembershipDetailsCard" >&2
  elif [[ "$allow_keychain_fallback" == "1" ]]; then
    echo "No Apple Team ID found. Open Xcode or install signing certificates first." >&2
  else
    echo "No Apple Team ID found in Xcode accounts. Open Xcode → Settings → Accounts and sign in, then retry." >&2
    echo "(Set IOS_ALLOW_KEYCHAIN_TEAM_FALLBACK=1 to allow keychain-only team detection.)" >&2
  fi
  exit 1
fi

for i in "${!team_ids[@]}"; do
  if [[ "${team_ids[$i]}" == "$canonical_team" ]]; then
    printf '%s\n' "${team_ids[$i]}"
    exit 0
  fi
done

if [[ "$require_canonical" == "1" ]]; then
  echo "Canonical OpenClaw iOS Team ID '${canonical_team}' is not available in Xcode on this machine." >&2
  echo "Sign into the Apple Developer account that owns the canonical team, or set IOS_DEVELOPMENT_TEAM=${canonical_team}." >&2
  exit 1
fi

if [[ -n "$preferred_team" ]]; then
  for i in "${!team_ids[@]}"; do
    if [[ "${team_ids[$i]}" == "$preferred_team" ]]; then
      printf '%s\n' "${team_ids[$i]}"
      exit 0
    fi
  done
fi

if [[ -n "$preferred_team_name" ]]; then
  preferred_team_name_lc="$(printf '%s' "$preferred_team_name" | tr '[:upper:]' '[:lower:]')"
  for i in "${!team_ids[@]}"; do
    team_name_lc="$(printf '%s' "${team_names[$i]}" | tr '[:upper:]' '[:lower:]')"
    if [[ "$team_name_lc" == "$preferred_team_name_lc" ]]; then
      printf '%s\n' "${team_ids[$i]}"
      exit 0
    fi
  done
fi

if [[ "$prefer_non_free_team" == "1" ]]; then
  for i in "${!team_ids[@]}"; do
    if [[ "${team_is_free[$i]}" == "0" ]]; then
      printf '%s\n' "${team_ids[$i]}"
      exit 0
    fi
  done
fi

printf '%s\n' "${team_ids[0]}"
