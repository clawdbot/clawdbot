#!/usr/bin/env bash
set -euo pipefail
root="/tmp/openclaw-mantis-proof-worktrees-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
baseline_root="$root/baseline"
candidate_root="$root/candidate"
mkdir -p "$root" "${RUNNER_TEMP}/mantis-corepack"
for sha in "$BASELINE_SHA" "$HEAD_SHA" "$MERGE_BASE_SHA"; do
  git cat-file -e "${sha}^{commit}" 2>/dev/null || git fetch --no-tags --depth 1 origin "$sha"
done
merge_rc=0
candidate_tree="$(git merge-tree --write-tree --merge-base="$MERGE_BASE_SHA" "$BASELINE_SHA" "$HEAD_SHA")" || merge_rc=$?
if ((merge_rc == 1)); then
  echo "::error::The PR conflicts with current main and must be rebased before Mantis can prove it."
  exit 1
elif ((merge_rc != 0)); then
  exit "$merge_rc"
fi
merge_date="$(git log -1 --format=%cI "$BASELINE_SHA")"
candidate_sha="$(
  GIT_AUTHOR_NAME=mantis-proof GIT_AUTHOR_EMAIL=mantis-proof@openclaw.ai \
  GIT_COMMITTER_NAME=mantis-proof GIT_COMMITTER_EMAIL=mantis-proof@openclaw.ai \
  GIT_AUTHOR_DATE="$merge_date" GIT_COMMITTER_DATE="$merge_date" \
  git commit-tree "$candidate_tree" -p "$BASELINE_SHA" -p "$HEAD_SHA" \
    -m "mantis candidate: PR #${PR_NUMBER} head ${HEAD_SHA} merged onto main ${BASELINE_SHA}"
)"
[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]]
git worktree add --detach "$baseline_root" "$BASELINE_SHA"
git worktree add --detach "$candidate_root" "$candidate_sha"
printf 'baseline\t%s\ncandidate\t%s\n' "$BASELINE_SHA" "$candidate_sha" | sudo tee /etc/openclaw-mantis-sut-revisions >/dev/null
sudo chmod 0444 /etc/openclaw-mantis-sut-revisions
{
  echo "baseline_root=$baseline_root"
  echo "candidate_root=$candidate_root"
  echo "candidate_revision=$candidate_sha"
  echo "lockfile_sha256=$(sha256sum "$baseline_root/pnpm-lock.yaml" | cut -d ' ' -f1)"
  echo "node_version=$(/usr/local/lib/mantis-toolchain/node --version)"
  echo "pnpm_version=$(/usr/local/lib/mantis-toolchain/pnpm --version)"
} >> "$GITHUB_OUTPUT"
