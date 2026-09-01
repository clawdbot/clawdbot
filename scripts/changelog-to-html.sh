#!/usr/bin/env bash
set -euo pipefail

VERSION=${1:-}
CHANGELOG_FILE=${2:-}

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [changelog_file]" >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ -z "$CHANGELOG_FILE" ]]; then
  if [[ -f "$SCRIPT_DIR/../CHANGELOG.md" ]]; then
    CHANGELOG_FILE="$SCRIPT_DIR/../CHANGELOG.md"
  elif [[ -f "CHANGELOG.md" ]]; then
    CHANGELOG_FILE="CHANGELOG.md"
  elif [[ -f "../CHANGELOG.md" ]]; then
    CHANGELOG_FILE="../CHANGELOG.md"
  else
    echo "Error: Could not find CHANGELOG.md" >&2
    exit 1
  fi
fi

if [[ ! -f "$CHANGELOG_FILE" ]]; then
  echo "Error: Changelog file '$CHANGELOG_FILE' not found" >&2
  exit 1
fi

extract_version_section() {
  local version=$1
  local file=$2
  awk -v version="$version" '
    BEGIN { found=0 }
    /^## / {
      if ($0 ~ "^##[[:space:]]+" version "([[:space:]].*|$)") { found=1; next }
      if (found) { exit }
    }
    found { print }
  ' "$file"
}

markdown_to_html() {
  # Keep substitution order and literal HTML unchanged, but process the whole
  # section once instead of spawning nine sed processes for every changelog line.
  sed \
    -e 's/^##### \(.*\)$/<h5>\1<\/h5>/' \
    -e 's/^#### \(.*\)$/<h4>\1<\/h4>/' \
    -e 's/^### \(.*\)$/<h3>\1<\/h3>/' \
    -e 's/^## \(.*\)$/<h2>\1<\/h2>/' \
    -e 's/^- \*\*\([^*]*\)\*\*\(.*\)$/<li><strong>\1<\/strong>\2<\/li>/' \
    -e 's/^- \([^*].*\)$/<li>\1<\/li>/' \
    -e 's/\*\*\([^*]*\)\*\*/<strong>\1<\/strong>/g' \
    -e 's/`\([^`]*\)`/<code>\1<\/code>/g' \
    -e 's/\[\([^]]*\)\](\([^)]*\))/<a href="\2">\1<\/a>/g'
}

version_content=$(extract_version_section "$VERSION" "$CHANGELOG_FILE")
if [[ -z "$version_content" ]]; then
  echo "<h2>OpenClaw $VERSION</h2>"
  echo "<p>Latest OpenClaw update.</p>"
  echo "<p><a href=\"https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md\">View full changelog</a></p>"
  exit 0
fi

echo "<h2>OpenClaw $VERSION</h2>"

{
  in_list=false
  while IFS= read -r line; do
    if [[ "$line" =~ ^- ]]; then
      if [[ "$in_list" == false ]]; then
        echo "<ul>"
        in_list=true
      fi
      printf '%s\n' "$line"
    else
      if [[ "$in_list" == true ]]; then
        echo "</ul>"
        in_list=false
      fi
      if [[ -n "$line" ]]; then
        printf '%s\n' "$line"
      fi
    fi
  done <<< "$version_content"

  if [[ "$in_list" == true ]]; then
    echo "</ul>"
  fi
} | markdown_to_html

echo "<p><a href=\"https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md\">View full changelog</a></p>"
