#!/usr/bin/env bash
set -euo pipefail

REMOTE_URL="${OPENCLAW_REF_REMOTE:-https://github.com/openclaw/openclaw.git}"
REF=""
EXPECTED_SHA=""
FALLBACK_OK=0
GITHUB_OUTPUT_FILE="${GITHUB_OUTPUT:-}"

usage() {
  cat >&2 <<'EOF'
Usage: resolve-openclaw-ref.sh --ref <ref> [--expected-sha <sha>] [--fallback-ok] [--github-output <file>]

Fast-resolves OpenClaw branch and tag refs with git ls-remote. Full commit SHAs
are returned as fallback refs so callers can decide whether to run deeper
reachability validation.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      REF="${2:-}"
      shift 2
      ;;
    --expected-sha)
      EXPECTED_SHA="${2:-}"
      shift 2
      ;;
    --fallback-ok)
      FALLBACK_OK=1
      shift
      ;;
    --github-output)
      GITHUB_OUTPUT_FILE="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

write_output() {
  local key="$1"
  local value="$2"
  if [[ -n "$GITHUB_OUTPUT_FILE" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT_FILE"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

resolve_unique_remote_ref() {
  local refspec
  local -a matches=()
  for refspec in "$@"; do
    [[ -n "$refspec" ]] || continue
    mapfile -t matches < <(
      git ls-remote "$REMOTE_URL" "$refspec" | awk '{print $1}' | awk '!seen[$0]++'
    )
    if [[ "${#matches[@]}" -eq 0 ]]; then
      continue
    fi
    if [[ "${#matches[@]}" -ne 1 ]]; then
      return 2
    fi
    printf '%s\n' "${matches[0]}"
    return 0
  done
  return 1
}

REF="$(trim "$REF")"
EXPECTED_SHA="$(trim "$EXPECTED_SHA")"
if [[ -z "$REF" ]] || [[ "$REF" == -* ]]; then
  echo "Expected a branch, tag, or full commit SHA; got: ${REF}" >&2
  exit 1
fi
if [[ -n "$EXPECTED_SHA" ]] && [[ ! "$EXPECTED_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Expected --expected-sha to be a full commit SHA; got: ${EXPECTED_SHA}" >&2
  exit 1
fi

if [[ "$REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
  if [[ -n "$EXPECTED_SHA" ]] && [[ "${REF,,}" != "${EXPECTED_SHA,,}" ]]; then
    echo "Ref SHA ${REF} does not match expected SHA ${EXPECTED_SHA}." >&2
    exit 1
  fi
  write_output sha "${REF,,}"
  write_output ref_kind sha
  write_output fast false
  write_output fallback true
  exit 0
fi

declare -a matches=()
if [[ "$REF" == refs/heads/* ]]; then
  mapfile -t matches < <(resolve_unique_remote_ref "$REF" || true)
elif [[ "$REF" == refs/tags/* ]]; then
  mapfile -t matches < <(resolve_unique_remote_ref "${REF}^{}" "$REF" || true)
elif [[ "$REF" == refs/* ]]; then
  mapfile -t matches < <(resolve_unique_remote_ref "$REF" || true)
else
  mapfile -t branch_matches < <(resolve_unique_remote_ref "refs/heads/${REF}" || true)
  mapfile -t tag_matches < <(resolve_unique_remote_ref "refs/tags/${REF}^{}" "refs/tags/${REF}" || true)
  match_count=$(( ${#branch_matches[@]} + ${#tag_matches[@]} ))
  if [[ "$match_count" -eq 1 ]]; then
    if [[ "${#branch_matches[@]}" -eq 1 ]]; then
      matches=("${branch_matches[0]}")
      ref_kind=branch
    else
      matches=("${tag_matches[0]}")
      ref_kind=tag
    fi
  elif [[ "$match_count" -gt 1 ]]; then
    echo "Ref resolved ambiguously as both branch and tag: ${REF}" >&2
    exit 1
  fi
fi

if [[ "${#matches[@]}" -eq 1 ]]; then
  resolved="${matches[0],,}"
  if [[ -n "$EXPECTED_SHA" ]] && [[ "$resolved" != "${EXPECTED_SHA,,}" ]]; then
    echo "Ref ${REF} resolved to ${resolved}, expected ${EXPECTED_SHA}." >&2
    exit 1
  fi
  if [[ -z "${ref_kind:-}" ]]; then
    if [[ "$REF" == refs/tags/* ]]; then
      ref_kind=tag
    elif [[ "$REF" == refs/heads/* ]]; then
      ref_kind=branch
    else
      ref_kind=ref
    fi
  fi
  write_output sha "$resolved"
  write_output ref_kind "$ref_kind"
  write_output fast true
  write_output fallback false
  exit 0
fi

if [[ "$FALLBACK_OK" -eq 1 ]]; then
  write_output sha "$EXPECTED_SHA"
  write_output ref_kind unknown
  write_output fast false
  write_output fallback true
  exit 0
fi

echo "Failed to resolve OpenClaw ref: ${REF}" >&2
exit 1
