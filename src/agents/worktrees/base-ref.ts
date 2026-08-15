import { commandError, requireGit, runGit } from "./git.js";

type ResolvedWorktreeBase = {
  gitOperand: string;
  recordRef: string;
  remote: boolean;
};

export async function resolveWorktreeBase(
  repoRoot: string,
  baseRef?: string,
): Promise<ResolvedWorktreeBase> {
  if (baseRef) {
    let gitOperand = baseRef;
    if (baseRef !== "-" && baseRef.startsWith("-")) {
      // `worktree add -b` forwards its start point to `git branch`, which parses
      // options again without another `--`; normalize dashed refs before that hop.
      // Force strict lookup so repository config cannot hide ambiguous ref names.
      const symbolic = await runGit(repoRoot, [
        "-c",
        "core.warnAmbiguousRefs=true",
        "rev-parse",
        "--symbolic-full-name",
        "--verify",
        "--end-of-options",
        baseRef,
      ]);
      const fullRef = symbolic.stdout.trim();
      if (symbolic.code !== 0) {
        throw commandError("git rev-parse --symbolic-full-name --verify", symbolic);
      }
      if (fullRef) {
        if (!fullRef.startsWith("refs/") || fullRef.includes("\n")) {
          throw commandError("git rev-parse --symbolic-full-name --verify", symbolic);
        }
        gitOperand = fullRef;
      } else {
        if (symbolic.stderr.trim()) {
          throw commandError("git rev-parse --symbolic-full-name --verify", symbolic);
        }
        gitOperand = await requireGit(repoRoot, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${baseRef}^{commit}`,
        ]);
      }
    }
    return { gitOperand, recordRef: baseRef, remote: false };
  }
  const fetched = await runGit(repoRoot, ["fetch", "origin"]);
  if (fetched.code === 0) {
    const remoteHead = await runGit(repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
      const remoteRef = remoteHead.stdout.trim();
      return { gitOperand: remoteRef, recordRef: remoteRef, remote: true };
    }
  }
  return { gitOperand: "HEAD", recordRef: "HEAD", remote: false };
}
