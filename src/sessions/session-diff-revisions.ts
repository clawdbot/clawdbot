import type { SessionsDiffResult } from "../../packages/gateway-protocol/src/index.js";
import { runGit } from "../agents/worktrees/git.js";

type GitOutput = (
  cwd: string,
  args: string[],
  okCodes?: readonly number[],
) => Promise<string | null>;

/** Picks the merge base used for branch-relative session diffs. */
export async function resolveSessionDiffBase(params: {
  branch: string | undefined;
  gitOut: GitOutput;
  root: string;
}): Promise<{ base: string; baseRef: string }> {
  const defaultRef = await params.gitOut(params.root, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const remoteDefault = defaultRef?.trim() || null;
  const defaultShort = remoteDefault?.replace(/^origin\//, "");
  if (remoteDefault && defaultShort && params.branch && params.branch !== defaultShort) {
    const mergeBase = await params.gitOut(params.root, ["merge-base", remoteDefault, "HEAD"]);
    if (mergeBase?.trim()) {
      return { base: mergeBase.trim(), baseRef: defaultShort };
    }
  }
  // Plain clones without origin/HEAD still get a branch-relative diff.
  if (params.branch && params.branch !== "main" && params.branch !== "master") {
    for (const candidate of ["main", "master"]) {
      const verified = await params.gitOut(params.root, [
        "rev-parse",
        "--verify",
        "--quiet",
        candidate,
      ]);
      if (verified?.trim()) {
        const mergeBase = await params.gitOut(params.root, ["merge-base", candidate, "HEAD"]);
        if (mergeBase?.trim()) {
          return { base: mergeBase.trim(), baseRef: candidate };
        }
      }
    }
  }
  return { base: "HEAD", baseRef: "HEAD" };
}

/** Resolves the repository-format-specific empty tree without writing it. */
export async function resolveSessionDiffEmptyTree(
  root: string,
): Promise<{ base: string; baseRef?: string } | null> {
  try {
    const result = await runGit(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
    const emptyTree = result.code === 0 ? result.stdout.trim() : "";
    return emptyTree ? { base: emptyTree } : null;
  } catch {
    return null;
  }
}

type BranchDiffMetadata = Pick<SessionsDiffResult, "aheadCount" | "commits" | "mergeBase">;

function parseCommitRecord(line: string): NonNullable<SessionsDiffResult["mergeBase"]> | undefined {
  const separator = line.indexOf("\0");
  if (separator <= 0) {
    return undefined;
  }
  return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
}

function parseCommitRecords(text: string): NonNullable<SessionsDiffResult["commits"]> {
  return text
    .split("\n")
    .map(parseCommitRecord)
    .filter(
      (record): record is NonNullable<SessionsDiffResult["mergeBase"]> => record !== undefined,
    );
}

/** Loads the bounded branch history metadata shared by every diff scope. */
export async function loadSessionDiffBranchMetadata(params: {
  base: string;
  gitOut: GitOutput;
  head: string;
  root: string;
}): Promise<BranchDiffMetadata> {
  if (params.base === "HEAD" || params.base === params.head) {
    return {};
  }
  const range = `${params.base}..HEAD`;
  const [aheadText, commitsText, mergeBaseText] = await Promise.all([
    params.gitOut(params.root, ["rev-list", "--count", range]),
    params.gitOut(params.root, ["log", "--max-count=50", "--format=%h%x00%s", range, "--"]),
    params.gitOut(params.root, ["show", "--no-patch", "--format=%h%x00%s", params.base, "--"]),
  ]);
  const normalizedAhead = aheadText?.trim();
  const aheadCount =
    normalizedAhead && /^\d+$/.test(normalizedAhead)
      ? Number.parseInt(normalizedAhead, 10)
      : undefined;
  const mergeBase = mergeBaseText ? parseCommitRecords(mergeBaseText)[0] : undefined;
  return {
    ...(aheadCount !== undefined ? { aheadCount } : {}),
    ...(commitsText !== null ? { commits: parseCommitRecords(commitsText) } : {}),
    ...(mergeBase ? { mergeBase } : {}),
  };
}
