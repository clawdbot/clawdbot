#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUN_NODE_TOOL="$ROOT_DIR/scripts/pre-commit/run-node-tool.sh"
FILTER_FILES="$ROOT_DIR/scripts/pre-commit/filter-staged-files.mjs"

if [[ ! -x "$RUN_NODE_TOOL" ]]; then
  echo "Missing helper: $RUN_NODE_TOOL" >&2
  exit 1
fi

if [[ ! -f "$FILTER_FILES" ]]; then
  echo "Missing helper: $FILTER_FILES" >&2
  exit 1
fi

GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || true)"
if [[ -n "$GIT_DIR" ]] && \
  { [[ -f "$GIT_DIR/MERGE_HEAD" ]] || \
    [[ -f "$GIT_DIR/CHERRY_PICK_HEAD" ]] || \
    [[ -f "$GIT_DIR/REVERT_HEAD" ]] || \
    [[ -d "$GIT_DIR/sequencer" ]] || \
    [[ -d "$GIT_DIR/rebase-merge" ]] || \
    [[ -d "$GIT_DIR/rebase-apply" ]]; }; then
  # Operation state owns staging; REBASE_HEAD alone does not establish an active rebase.
  exit 0
fi

# Security: avoid option-injection from malicious file names (e.g. "--all", "--force").
# Robustness: NUL-delimited file list handles spaces/newlines safely.
# Compatibility: use read loops instead of `mapfile` so this runs on macOS Bash 3.x;
# expand possibly-empty arrays only behind length guards (empty "${arr[@]}" trips set -u).
files=()
while IFS= read -r -d '' file; do
  files+=("$file")
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

if [ "${#files[@]}" -eq 0 ]; then
  exit 0
fi

unignored_files=()
for file in "${files[@]}"; do
  # check-ignore rejects global literal magic; ./ keeps leading-colon names literal too.
  if ! git --no-literal-pathspecs check-ignore --no-index -q -- "./$file"; then
    unignored_files+=("$file")
  fi
done

if [ "${#unignored_files[@]}" -eq 0 ]; then
  exit 0
fi

format_files=()
while IFS= read -r -d '' file; do
  format_files+=("$file")
done < <(node "$FILTER_FILES" format -- "${unignored_files[@]}")

if [ "${#format_files[@]}" -eq 0 ]; then
  exit 0
fi

# Partial staging: a file whose working-tree bytes differ from its staged bytes carries
# unstaged work that must never reach the index. Only fully staged files may be formatted
# in place and restaged; partially staged files get index-only formatting below.
# --literal-pathspecs: enumerated names re-enter Git as pathspecs; without it, bracket or
# ":(...)" magic in a filename could select the wrong paths regardless of caller env.
partial_files=()
while IFS= read -r -d '' file; do
  partial_files+=("$file")
done < <(git --literal-pathspecs diff --name-only -z -- "${format_files[@]}")

inplace_files=()
if [ "${#partial_files[@]}" -eq 0 ]; then
  inplace_files=("${format_files[@]}")
  staged_only_files=()
else
  staged_only_files=()
  for file in "${format_files[@]}"; do
    partial=0
    for partial_file in "${partial_files[@]}"; do
      if [[ "$file" == "$partial_file" ]]; then
        partial=1
        break
      fi
    done
    if [ "$partial" -eq 1 ]; then
      staged_only_files+=("$file")
    else
      inplace_files+=("$file")
    fi
  done
fi

if [ "${#inplace_files[@]}" -gt 0 ]; then
  "$RUN_NODE_TOOL" oxfmt --write --no-error-on-unmatched-pattern "${inplace_files[@]}"
  git --literal-pathspecs add -- "${inplace_files[@]}"
fi

if [ "${#staged_only_files[@]}" -eq 0 ]; then
  exit 0
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
index_updates="$tmp_dir/index-updates"
formatted="$tmp_dir/formatted"
: > "$index_updates"

# Format each partially staged blob exactly as staged: stdin mode applies the same repo
# config and ignorePatterns as the batch run, keyed by --stdin-filepath. The working
# file keeps its bytes; the unstaged remainder stays an ordinary unstaged diff.
while IFS= read -r -d '' entry; do
  meta="${entry%%$'\t'*}"
  file="${entry#*$'\t'}"
  mode="${meta%% *}"
  rest="${meta#* }"
  oid="${rest%% *}"
  stage="${rest#* }"
  # Only regular staged blobs are formattable; symlinks and conflict stages keep their entries.
  if [[ "$stage" != "0" ]] || { [[ "$mode" != "100644" ]] && [[ "$mode" != "100755" ]]; }; then
    continue
  fi
  git cat-file blob "$oid" | "$RUN_NODE_TOOL" oxfmt --stdin-filepath="$file" > "$formatted"
  # A formatter that exits 0 with empty output for nonempty input must not empty the file.
  if [[ ! -s "$formatted" ]] && [ "$(git cat-file -s "$oid")" -gt 0 ]; then
    echo "Formatter returned no output for partially staged file: $file" >&2
    exit 1
  fi
  # Staged blobs are already index-form (filters/eol applied on add); hash verbatim.
  new_oid="$(git hash-object -w -t blob --no-filters -- "$formatted")"
  if [[ "$new_oid" != "$oid" ]]; then
    printf '%s %s\t%s\0' "$mode" "$new_oid" "$file" >> "$index_updates"
  fi
done < <(git --literal-pathspecs ls-files --stage -z -- "${staged_only_files[@]}")

if [ -s "$index_updates" ]; then
  git update-index -z --index-info < "$index_updates"
fi
