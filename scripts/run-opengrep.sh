#!/usr/bin/env bash
# scripts/run-opengrep.sh
#
# Run the OpenClaw precise OpenGrep rulepack against the local working tree
# using the same paths and exclusions as CI. The .semgrepignore at the repo root
# is the single source of truth for skipped paths.
#
# Usage:
#   scripts/run-opengrep.sh                    # precise, human output
#   scripts/run-opengrep.sh precise            # same
#   scripts/run-opengrep.sh --sarif            # write SARIF for upload/triage
#   scripts/run-opengrep.sh --json             # write JSON for ad-hoc parsing
#   scripts/run-opengrep.sh --changed          # scan changed first-party paths
#   scripts/run-opengrep.sh --error            # fail non-zero on findings
#
# Optional positional path overrides come last:
#   scripts/run-opengrep.sh -- src/agents/     # scan a single dir
#
# Exit code: non-zero on scan errors, and on findings when --error is passed.

set -euo pipefail

BUCKET="precise"
if [[ "${1:-}" == "precise" ]]; then
  shift
elif [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,22p' "$0"
  exit 0
elif [[ "${1:-}" == "broad" ]]; then
  echo "error: broad OpenGrep rulepacks are not supported in this repo workflow" >&2
  exit 64
fi

# Resolve repo root from this script's location so the command works from any cwd.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$REPO_ROOT/security/opengrep/precise.yml"

if [[ ! -f "$CONFIG" ]]; then
  echo "error: rulepack not found at $CONFIG" >&2
  echo "Recompile with: node security/opengrep/compile-rules.mjs --rules-dir <rules-dir> --out-dir security/opengrep" >&2
  exit 66
fi

if ! command -v opengrep >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: 'opengrep' not found on PATH.

Install with one of:
  curl -fsSL https://raw.githubusercontent.com/opengrep/opengrep/v1.19.0/install.sh | bash -s -- -v v1.19.0
  brew install opengrep/tap/opengrep
  pipx install opengrep

(See https://opengrep.dev for other options.)
EOF
  exit 127
fi

# Pull off our own flags from the remaining args; pass everything else through to opengrep.
EXTRA_ARGS=()
PATHS_PASSED=0
SAW_DOUBLE_DASH=0
CHANGED_ONLY=0
FAIL_ON_FINDINGS=0
while (( $# > 0 )); do
  case "$1" in
    --sarif)
      mkdir -p "$REPO_ROOT/.opengrep-out"
      EXTRA_ARGS+=( "--sarif-output=$REPO_ROOT/.opengrep-out/$BUCKET.sarif" )
      shift
      ;;
    --json)
      mkdir -p "$REPO_ROOT/.opengrep-out"
      EXTRA_ARGS+=( "--json" "--output=$REPO_ROOT/.opengrep-out/$BUCKET.json" )
      shift
      ;;
    --changed)
      CHANGED_ONLY=1
      shift
      ;;
    --error)
      FAIL_ON_FINDINGS=1
      shift
      ;;
    --)
      SAW_DOUBLE_DASH=1
      shift
      ;;
    *)
      if (( SAW_DOUBLE_DASH )); then
        # Treat anything after `--` as a path-positional override
        if (( PATHS_PASSED == 0 )); then
          PATHS_PASSED=1
          EXTRA_ARGS+=( "$1" )
        else
          EXTRA_ARGS+=( "$1" )
        fi
      else
        EXTRA_ARGS+=( "$1" )
      fi
      shift
      ;;
  esac
done

cd "$REPO_ROOT"

if (( CHANGED_ONLY && PATHS_PASSED )); then
  echo "error: --changed cannot be combined with explicit path overrides" >&2
  exit 64
fi

# Default scan paths match CI. Override by passing `-- <paths...>`.
if (( PATHS_PASSED == 0 )); then
  if (( CHANGED_ONLY )); then
    SCAN_PATHS=()
    while IFS= read -r path; do
      SCAN_PATHS+=( "$path" )
    done < <(
      {
        git diff --name-only --diff-filter=ACMRTUXB "${OPENCLAW_OPENGREP_BASE_REF:-origin/main...HEAD}" 2>/dev/null || true
        git diff --name-only --diff-filter=ACMRTUXB -- 2>/dev/null || true
        git ls-files --others --exclude-standard
      } | awk '/^(src|extensions|apps|packages|scripts)\// { print }' | sort -u
    )
    RULEPACK_CHANGED_PATHS=()
    while IFS= read -r path; do
      RULEPACK_CHANGED_PATHS+=( "$path" )
    done < <(
      {
        git diff --name-only --diff-filter=ACMRTUXB "${OPENCLAW_OPENGREP_BASE_REF:-origin/main...HEAD}" 2>/dev/null || true
        git diff --name-only --diff-filter=ACMRTUXB -- 2>/dev/null || true
        git ls-files --others --exclude-standard
      } | awk '/^(security\/opengrep\/|scripts\/run-opengrep\.sh$|\.semgrepignore$|\.github\/workflows\/opengrep-)/ { print }' | sort -u
    )
    if (( ${#SCAN_PATHS[@]} == 0 && ${#RULEPACK_CHANGED_PATHS[@]} > 0 )); then
      # Exercise rulepack loading without scanning the compiled YAML, which contains
      # rule pattern literals that can match themselves.
      SCAN_PATHS=( "scripts/run-opengrep.sh" )
    fi
    if (( ${#SCAN_PATHS[@]} == 0 )); then
      echo "→ No changed first-party paths for opengrep." >&2
      exit 0
    fi
  else
    SCAN_PATHS=( "src/" "extensions/" "apps/" "packages/" "scripts/" )
  fi
else
  SCAN_PATHS=()
fi

if (( FAIL_ON_FINDINGS )); then
  EXTRA_ARGS+=( "--error" )
fi

echo "→ Running opengrep ($BUCKET) against $(IFS=' '; echo "${SCAN_PATHS[*]:-overridden}")" >&2
echo "  Using exclusions from .semgrepignore" >&2
OPENGREP_ARGS=( scan --no-strict --config "$CONFIG" --no-git-ignore )
if (( ${#EXTRA_ARGS[@]} > 0 )); then
  OPENGREP_ARGS+=( "${EXTRA_ARGS[@]}" )
fi
if (( ${#SCAN_PATHS[@]} > 0 )); then
  OPENGREP_ARGS+=( "${SCAN_PATHS[@]}" )
fi
exec opengrep "${OPENGREP_ARGS[@]}"
