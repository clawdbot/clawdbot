import { managedWorktrees } from "../agents/worktrees/service.js";
import { recoverGitHubPublicationBranchAndIndex } from "./github-publication-git-index.js";
import type { GitHubPublicationExecutionRow } from "./github-publication-store.js";

type PublicationRow = GitHubPublicationExecutionRow;
type GitCommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string };

export async function recoverGitHubPublicationWorkspace(
  row: PublicationRow,
  run: (argv: string[], options?: GitCommandOptions) => Promise<string>,
  assertCurrent: () => void,
): Promise<void> {
  const worktree = managedWorktrees.findLiveById(row.worktree_id);
  if (
    worktree?.repoFingerprint !== row.repository_fingerprint ||
    worktree.branch !== row.branch ||
    !row.source_head_commit ||
    !row.workspace_tree
  ) {
    return;
  }
  await recoverGitHubPublicationBranchAndIndex({
    cwd: worktree.path,
    requestId: row.request_id,
    branch: row.branch,
    sourceHeadCommit: row.source_head_commit,
    workspaceTree: row.workspace_tree,
    assertCurrent,
    run,
  });
}
