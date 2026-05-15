changelog_helper_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

changelog_attribution_script() {
  printf '%s\n' "$(changelog_helper_root)/scripts/check-changelog-attributions.mjs"
}

normalize_pr_changelog_entries() {
  local pr="$1"
  local changelog_path="CHANGELOG.md"

  [ -f "$changelog_path" ] || return 0

  PR_NUMBER_FOR_CHANGELOG="$pr" node <<'EOF_NODE'
const fs = require("node:fs");

const pr = process.env.PR_NUMBER_FOR_CHANGELOG;
const path = "CHANGELOG.md";
const original = fs.readFileSync(path, "utf8");
const lines = original.split("\n");
const prPattern = new RegExp(`(?:\\(#${pr}\\)|openclaw#${pr})`, "i");

function findActiveSectionIndex(arr) {
  const versionUnreleasedIndex = arr.findIndex((line) =>
    /^##\s+.+\(\s*unreleased\s*\)\s*$/i.test(line.trim()),
  );
  if (versionUnreleasedIndex !== -1) {
    return versionUnreleasedIndex;
  }
  return arr.findIndex((line) => line.trim().toLowerCase() === "## unreleased");
}

function findSectionEnd(arr, start) {
  for (let i = start + 1; i < arr.length; i += 1) {
    if (/^## /.test(arr[i])) {
      return i;
    }
  }
  return arr.length;
}

function ensureActiveSection(arr) {
  let activeIndex = findActiveSectionIndex(arr);
  if (activeIndex !== -1) {
    return activeIndex;
  }

  let insertAt = arr.findIndex((line, idx) => idx > 0 && /^## /.test(line));
  if (insertAt === -1) {
    insertAt = arr.length;
  }

  const block = ["## Unreleased", "", "### Changes", ""];
  if (insertAt > 0 && arr[insertAt - 1] !== "") {
    block.unshift("");
  }
  arr.splice(insertAt, 0, ...block);
  return findActiveSectionIndex(arr);
}

function contextFor(arr, index) {
  let major = "";
  let minor = "";
  for (let i = index; i >= 0; i -= 1) {
    const line = arr[i];
    if (!minor && /^### /.test(line)) {
      minor = line.trim();
    }
    if (/^## /.test(line)) {
      major = line.trim();
      break;
    }
  }
  return { major, minor };
}

function ensureSubsection(arr, subsection) {
  const activeIndex = ensureActiveSection(arr);
  const activeEnd = findSectionEnd(arr, activeIndex);
  const desired = subsection && /^### /.test(subsection) ? subsection : "### Changes";
  for (let i = activeIndex + 1; i < activeEnd; i += 1) {
    if (arr[i].trim() === desired) {
      return i;
    }
  }

  let insertAt = activeEnd;
  while (insertAt > activeIndex + 1 && arr[insertAt - 1] === "") {
    insertAt -= 1;
  }
  const block = ["", desired, ""];
  arr.splice(insertAt, 0, ...block);
  return insertAt + 1;
}

function sectionTailInsertIndex(arr, subsectionIndex) {
  let nextHeading = arr.length;
  for (let i = subsectionIndex + 1; i < arr.length; i += 1) {
    if (/^### /.test(arr[i]) || /^## /.test(arr[i])) {
      nextHeading = i;
      break;
    }
  }

  let insertAt = nextHeading;
  while (insertAt > subsectionIndex + 1 && arr[insertAt - 1] === "") {
    insertAt -= 1;
  }
  return insertAt;
}

const activeHeading = lines[ensureActiveSection(lines)]?.trim() || "## Unreleased";

const moved = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!prPattern.test(lines[i])) {
    continue;
  }
  const ctx = contextFor(lines, i);
  if (ctx.major === activeHeading) {
    continue;
  }
  moved.push({
    line: lines[i],
    subsection: ctx.minor || "### Changes",
    index: i,
  });
}

if (moved.length === 0) {
  process.exit(0);
}

const removeIndexes = new Set(moved.map((entry) => entry.index));
const nextLines = lines.filter((_, idx) => !removeIndexes.has(idx));

for (const entry of moved) {
  const subsectionIndex = ensureSubsection(nextLines, entry.subsection);
  const insertAt = sectionTailInsertIndex(nextLines, subsectionIndex);

  let nextHeading = nextLines.length;
  for (let i = subsectionIndex + 1; i < nextLines.length; i += 1) {
    if (/^### /.test(nextLines[i]) || /^## /.test(nextLines[i])) {
      nextHeading = i;
      break;
    }
  }

  const alreadyPresent = nextLines
    .slice(subsectionIndex + 1, nextHeading)
    .some((line) => line === entry.line);
  if (alreadyPresent) {
    continue;
  }
  nextLines.splice(insertAt, 0, entry.line);
}

const updated = nextLines.join("\n");
if (updated !== original) {
  fs.writeFileSync(path, updated);
}
EOF_NODE
}

validate_changelog_attribution_policy() {
  node "$(changelog_attribution_script)" CHANGELOG.md
}

changelog_thanks_required_for_contributor() {
  local contrib="${1:-}"
  [ -n "$contrib" ] || return 1
  node "$(changelog_attribution_script)" --is-forbidden-handle "$contrib" && return 1

  return 0
}

changelog_explicit_human_thanks_required_for_contributor() {
  local contrib="${1:-}"
  [ -n "$contrib" ] || return 1
  node "$(changelog_attribution_script)" --requires-explicit-human-thanks "$contrib"
}

validate_changelog_entry_for_pr() {
  local pr="$1"
  local contrib="$2"

  local added_lines
  added_lines=$(git diff --unified=0 origin/main...HEAD -- CHANGELOG.md | awk '
    /^\+\+\+/ { next }
    /^\+/ { print substr($0, 2) }
  ')

  if [ -z "$added_lines" ]; then
    echo "CHANGELOG.md is in diff but no added lines were detected."
    exit 1
  fi

  local pr_pattern
  pr_pattern="(#$pr|openclaw#$pr)"

  local with_pr
  with_pr=$(printf '%s\n' "$added_lines" | rg -in "$pr_pattern" || true)
  if [ -z "$with_pr" ]; then
    echo "CHANGELOG.md update must reference PR #$pr (for example, (#$pr))."
    exit 1
  fi

  local diff_file
  diff_file=$(mktemp)
  git diff --unified=0 origin/main...HEAD -- CHANGELOG.md > "$diff_file"

  if ! awk -v pr_pattern="$pr_pattern" '
BEGIN {
  line_no = 0
  file_line_count = 0
  issue_count = 0
}
FNR == NR {
  if ($0 ~ /^@@ /) {
    if (match($0, /\+[0-9]+/)) {
      line_no = substr($0, RSTART + 1, RLENGTH - 1) + 0
    } else {
      line_no = 0
    }
    next
  }
  if ($0 ~ /^\+\+\+/) {
    next
  }
  if ($0 ~ /^\+/) {
    if (line_no > 0) {
      added[line_no] = 1
      added_text = substr($0, 2)
      if (added_text ~ pr_pattern) {
        pr_added_lines[++pr_added_count] = line_no
        pr_added_text[line_no] = added_text
      }
      line_no++
    }
    next
  }
  if ($0 ~ /^-/) {
    next
  }
  if (line_no > 0) {
    line_no++
  }
  next
}
{
  changelog[FNR] = $0
  file_line_count = FNR
}
END {
  active_release_line = 0
  bare_release_line = 0
  active_release_name = "unreleased"
  for (i = 1; i <= file_line_count; i++) {
    if (changelog[i] !~ /^## /) {
      continue
    }
    heading = tolower(changelog[i])
    if (heading ~ /^##[[:space:]]+.+\([[:space:]]*unreleased[[:space:]]*\)[[:space:]]*$/) {
      active_release_line = i
      active_release_name = changelog[i]
      break
    }
    if (heading == "## unreleased" && bare_release_line == 0) {
      bare_release_line = i
    }
  }
  if (active_release_line == 0 && bare_release_line != 0) {
    active_release_line = bare_release_line
    active_release_name = changelog[bare_release_line]
  }

  for (idx = 1; idx <= pr_added_count; idx++) {
    entry_line = pr_added_lines[idx]
    release_line = 0
    section_line = 0
    for (i = entry_line; i >= 1; i--) {
      if (section_line == 0 && changelog[i] ~ /^### /) {
        section_line = i
        continue
      }
      if (changelog[i] ~ /^## /) {
        release_line = i
        break
      }
    }
    if (release_line == 0 || release_line != active_release_line) {
      printf "CHANGELOG.md PR-linked entry must be in %s: line %d: %s\n", active_release_name, entry_line, pr_added_text[entry_line]
      issue_count++
      continue
    }
    if (section_line == 0) {
      printf "CHANGELOG.md entry must be inside a subsection (### ...): line %d: %s\n", entry_line, pr_added_text[entry_line]
      issue_count++
      continue
    }

    section_name = changelog[section_line]
    next_heading = file_line_count + 1
    for (i = entry_line + 1; i <= file_line_count; i++) {
      if (changelog[i] ~ /^### / || changelog[i] ~ /^## /) {
        next_heading = i
        break
      }
    }

    for (i = entry_line + 1; i < next_heading; i++) {
      line_text = changelog[i]
      if (line_text ~ /^[[:space:]]*$/) {
        continue
      }
      if (i in added) {
        continue
      }
      printf "CHANGELOG.md PR-linked entry must be appended at the end of section %s: line %d: %s\n", section_name, entry_line, pr_added_text[entry_line]
      printf "Found existing non-added line below it at line %d: %s\n", i, line_text
      issue_count++
      break
    }
  }

  if (issue_count > 0) {
    print "Move this PR changelog entry to the end of its section (just before the next heading)."
    exit 1
  }
}
' "$diff_file" CHANGELOG.md; then
    rm -f "$diff_file"
    exit 1
  fi
  rm -f "$diff_file"
  echo "changelog placement validated: PR-linked entries are appended at section tail"

  if changelog_thanks_required_for_contributor "$contrib"; then
    local with_pr_and_thanks
    with_pr_and_thanks=$(printf '%s\n' "$added_lines" | rg -in "$pr_pattern" | rg -i "thanks @$contrib" || true)
    if [ -z "$with_pr_and_thanks" ]; then
      echo "CHANGELOG.md update must include both PR #$pr and thanks @$contrib on the changelog entry line."
      exit 1
    fi
    echo "changelog validated: found PR #$pr + thanks @$contrib"
    return 0
  fi

  if ! changelog_explicit_human_thanks_required_for_contributor "$contrib"; then
    echo "changelog validated: found PR #$pr (no eligible human contributor handle, skipping thanks check)"
    return 0
  fi

  local with_pr_and_any_thanks
  with_pr_and_any_thanks=$(printf '%s\n' "$added_lines" | rg -in "$pr_pattern" | rg -i '\bthanks[[:space:]]+@' || true)
  if [ -z "$with_pr_and_any_thanks" ]; then
    echo "CHANGELOG.md update for bot/app/non-creditable author $contrib must include an explicit human Thanks @handle on the PR #$pr entry line."
    echo "Choose the credited original contributor, or stop for maintainer input if authorship is unclear."
    exit 1
  fi

  echo "changelog validated: found PR #$pr + explicit thanks for bot/app/non-creditable author $contrib"
}

validate_changelog_merge_hygiene() {
  local diff
  diff=$(git diff --unified=0 origin/main...HEAD -- CHANGELOG.md)

  local removed_lines
  removed_lines=$(printf '%s\n' "$diff" | awk '
    /^---/ { next }
    /^-/ { print substr($0, 2) }
  ')
  if [ -z "$removed_lines" ]; then
    return 0
  fi

  local removed_refs
  removed_refs=$(printf '%s\n' "$removed_lines" | rg -o '#[0-9]+' | sort -u || true)
  if [ -z "$removed_refs" ]; then
    return 0
  fi

  local added_lines
  added_lines=$(printf '%s\n' "$diff" | awk '
    /^\+\+\+/ { next }
    /^\+/ { print substr($0, 2) }
  ')

  local ref
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    if ! printf '%s\n' "$added_lines" | rg -q -F "$ref"; then
      echo "CHANGELOG.md drops existing entry reference $ref without re-adding it."
      echo "Likely merge conflict loss; restore the dropped entry (or keep the same PR ref in rewritten text)."
      exit 1
    fi
  done <<<"$removed_refs"

  echo "changelog merge hygiene validated: no dropped PR references"
}
