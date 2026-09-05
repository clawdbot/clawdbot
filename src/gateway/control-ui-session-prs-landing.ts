// Landing resolution for a session's working branch: which merged PRs count
// as landed on the checkout's default branch, the newest known-published
// baseline for working-tree stats, and whether new pushed work is provable
// (the Create PR gate). Pure local-git reasoning; GitHub facts come in as
// MergedPullHead records.
import { runGit } from "../agents/worktrees/git.js";

/** Lowercased merged-PR head, the base it merged into, and its merge commit. */
export type MergedPullHead = { sha: string; baseRef?: string; mergeCommitSha?: string };

type BranchLanding = {
  /** origin/<branch> tip when the remote-tracking ref resolves. */
  pushedSha: string | null;
  /** Newest known-published commit to diff the working tree against. */
  statsBase: string | null;
  /** At least one merged PR provably landed on the default branch. */
  hasLandedPullRequest: boolean;
  /** The merge base contains every known landing, so Create PR is safe. */
  provenNewPushedWork: boolean;
};

export async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await runGit(cwd, args);
    return result.code === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    const result = await runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Picks the newest of the known-published baseline candidates. Two candidates
 * (the dominant case) stay a single ancestry call; larger sets batch through
 * one `merge-base --independent`. Among incomparable maxima, a candidate
 * containing the first entry (the merge base) is preferred — any such pick is
 * sound because it covers everything the merge base covers — and otherwise
 * the earliest candidate wins, keeping the merge base as the safe default.
 */
async function maximalCommit(root: string, candidates: readonly string[]): Promise<string | null> {
  const unique = [...new Set(candidates)];
  const first = unique[0];
  if (first === undefined) {
    return null;
  }
  if (unique.length === 1) {
    return first;
  }
  const second = unique[1];
  if (unique.length === 2 && second !== undefined) {
    return (await isAncestor(root, first, second)) ? second : first;
  }
  // Candidates are verified local objects, so a failed call is unexpected;
  // fall back to the merge base rather than guessing.
  const out = await gitOutput(root, ["merge-base", "--independent", ...unique]);
  if (!out) {
    return first;
  }
  const independent = new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  if (independent.has(first)) {
    return first;
  }
  for (const candidate of unique.slice(1)) {
    if (independent.has(candidate) && (await isAncestor(root, first, candidate))) {
      return candidate;
    }
  }
  return unique.find((candidate) => independent.has(candidate)) ?? first;
}

export async function resolveBranchLanding(
  root: string,
  params: {
    branch: string;
    defaultBranch?: string;
    mergedHeads: readonly MergedPullHead[];
  },
): Promise<BranchLanding> {
  const pushedSha = await gitOutput(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${params.branch}`,
  ]);
  // HEAD is only used to compare landed PR heads; keep its read order when needed.
  const headSha = params.mergedHeads.length ? await gitOutput(root, ["rev-parse", "HEAD"]) : null;
  // Only merges whose content reached this checkout's default branch prove
  // the tip landed there: a direct default-base merge, or a landing through
  // another branch (feature -> release -> main) whose merge commit is now
  // contained in the default branch. A PR merged into an unpropagated
  // release/staging branch must not hide Create PR. Filtered here, not in
  // the snapshot cache, because the cache key has no default branch.
  const defaultRef = params.defaultBranch ? `refs/remotes/origin/${params.defaultBranch}` : null;
  const landedHeads: MergedPullHead[] = [];
  for (const head of params.mergedHeads) {
    if (head.baseRef === params.defaultBranch) {
      landedHeads.push(head);
    } else if (
      defaultRef &&
      head.mergeCommitSha &&
      (await isAncestor(root, head.mergeCommitSha, defaultRef))
    ) {
      landedHeads.push(head);
    }
  }
  const landedShas = landedHeads.map((head) => head.sha);
  const mergeBase = defaultRef ? await gitOutput(root, ["merge-base", defaultRef, "HEAD"]) : null;
  // The stats base is the newest commit whose content is known-published:
  // the ordinary default-branch merge base, or a merged PR head related to
  // HEAD by ancestry (a HEAD trailing the merged tip is fully landed, so
  // HEAD itself is the baseline). Diffing against anything older would
  // replay landed work as pending — squash-merged commits are never
  // ancestors of the default branch, so the merge base alone cannot see
  // them. Ancestry is best-effort: a merged head never fetched locally
  // cannot be proven related and falls back to the merge base.
  const baselines: string[] = mergeBase ? [mergeBase] : [];
  if (headSha) {
    for (const merged of landedShas) {
      if (await isAncestor(root, merged, headSha)) {
        baselines.push(merged);
      } else if (await isAncestor(root, headSha, merged)) {
        baselines.push(headSha);
      }
    }
  }
  const statsBase = await maximalCommit(root, baselines);
  // Squash merges leave origin/<branch> "ahead" of the default branch
  // forever, so local git alone would keep offering Create PR after the work
  // landed. Once merged PRs exist, the link returns only when the merge base
  // provably contains EVERY known landing — a squash landing is visible via
  // its merge commit (checked first: the common case), a merge-commit landing
  // via the head itself, and an older landing must not vouch for a newer one
  // whose diff a new PR would replay. A tip merely descending from a squashed
  // head or a fetch-stale tracking ref proves nothing, so those states keep
  // the row stats-only until a rebase or fetch.
  let provenNewPushedWork = false;
  if (pushedSha && mergeBase && !landedShas.includes(pushedSha.toLowerCase())) {
    provenNewPushedWork = landedHeads.length > 0;
    for (const head of landedHeads) {
      const incorporated =
        (head.mergeCommitSha ? await isAncestor(root, head.mergeCommitSha, mergeBase) : false) ||
        (await isAncestor(root, head.sha, mergeBase));
      if (!incorporated) {
        provenNewPushedWork = false;
        break;
      }
    }
  }
  return {
    pushedSha,
    statsBase,
    hasLandedPullRequest: landedHeads.length > 0,
    provenNewPushedWork,
  };
}
