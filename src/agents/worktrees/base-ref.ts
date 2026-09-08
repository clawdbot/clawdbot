import { requireGitCommandOutput } from "../../infra/git-exec.js";
import { commandError, runGit } from "./git.js";

type ResolvedWorktreeBase = {
  commit: string;
  gitOperand: string;
  recordRef: string;
  remote: boolean;
};

export class InvalidWorktreeBaseRefError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Worktree base ref does not resolve to a commit. Choose a local or remote branch and retry.",
      options,
    );
    this.name = "InvalidWorktreeBaseRefError";
  }
}

export async function resolveWorktreeBase(
  repoRoot: string,
  baseRef?: string,
  signal?: AbortSignal,
): Promise<ResolvedWorktreeBase> {
  if (baseRef) {
    const verified = await runGit(
      repoRoot,
      [
        "-c",
        "core.warnAmbiguousRefs=true",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${baseRef === "-" ? "@{-1}" : baseRef}^{commit}`,
      ],
      { signal },
    );
    signal?.throwIfAborted();
    if (
      verified.termination === "exit" &&
      typeof verified.code === "number" &&
      verified.code !== 0
    ) {
      throw new InvalidWorktreeBaseRefError({
        cause: commandError("git rev-parse --verify", verified),
      });
    }
    const commit = requireGitCommandOutput("git rev-parse --verify", verified).trim();
    if (!commit || commit.includes("\n") || verified.stderr.trim()) {
      throw new InvalidWorktreeBaseRefError({
        cause: commandError("git rev-parse --verify", verified),
      });
    }
    // `worktree add -b` forwards its start point to `git branch`, which parses
    // options again without another `--`; pass the verified commit for dashed refs.
    const gitOperand = baseRef !== "-" && baseRef.startsWith("-") ? commit : baseRef;
    return { commit, gitOperand, recordRef: baseRef, remote: false };
  }
  const fetched = await runGit(repoRoot, ["fetch", "origin"], { signal });
  signal?.throwIfAborted();
  if (fetched.termination === "exit" && fetched.code === 0) {
    const remoteHead = await runGit(repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (remoteHead.termination === "exit" && remoteHead.code === 0 && remoteHead.stdout.trim()) {
      const remoteRef = remoteHead.stdout.trim();
      const resolved = await resolveWorktreeBase(repoRoot, remoteRef, signal);
      return { ...resolved, remote: true };
    }
  }
  return await resolveWorktreeBase(repoRoot, "HEAD", signal);
}
