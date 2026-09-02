import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { resolveGitHubPublicationWorktreeOwner } from "./github-publication-availability.js";
import { parseGitHubPublicationBaseBranch } from "./github-publication-base.js";
import { GitHubPublicationWorkspaceChangedError } from "./github-publication-failure.js";
import { requirePublicationCommand } from "./github-publication-git-transport.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { resolveGitHubRepositoryTarget } from "./github-repository-target.js";

/** Resolve the authoritative Git remote and GitHub PR parent with the selected publisher. */
export async function prepareGitHubPublicationTarget(params: {
  worktree: ReturnType<typeof resolveGitHubPublicationWorktreeOwner>["worktree"];
  identity: PreparedGitHubPublicationIdentity;
  assertCurrent: () => void;
}) {
  const { worktree, assertCurrent } = params;
  assertCurrent();
  const repositoryIdentity = await managedWorktrees.resolveRepositoryIdentity(worktree.path);
  assertCurrent();
  if (
    repositoryIdentity.checkoutRoot !== worktree.path ||
    repositoryIdentity.repoRoot !== worktree.repoRoot ||
    repositoryIdentity.fingerprint !== worktree.repoFingerprint
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication workspace repository changed.",
    );
  }
  const remote = parseGitHubRemoteUrl(repositoryIdentity.originUrl);
  if (
    !remote ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
  ) {
    throw new Error("GitHub publication requires a GitHub remote.");
  }
  const pushRepository = `${remote.owner}/${remote.repo}`;
  const branch = await requirePublicationCommand(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: worktree.path },
  );
  assertCurrent();
  if (branch !== worktree.branch) {
    throw new GitHubPublicationWorkspaceChangedError("GitHub publication branch changed.");
  }
  const raw = await requirePublicationCommand(
    [
      "gh",
      "api",
      "--hostname",
      "github.com",
      `repos/${pushRepository}`,
      "--jq",
      "{fork, default_branch, parent: {name: .parent.name, default_branch: .parent.default_branch, owner: {login: .parent.owner.login}}}",
    ],
    { env: params.identity.env },
  );
  assertCurrent();
  const value: unknown = JSON.parse(raw);
  const target = isRecord(value) ? resolveGitHubRepositoryTarget(value, remote) : undefined;
  if (!target) {
    throw new Error("GitHub repository response omitted its publication target.");
  }
  const repository = `${target.pullRequest.owner}/${target.pullRequest.repo}`;
  const baseBranch = target.fork
    ? target.pullRequest.defaultBranch
    : parseGitHubPublicationBaseBranch(worktree.baseRef, target.pullRequest.defaultBranch);
  if (!target.fork && branch === baseBranch) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication branch changed to its pull request base.",
    );
  }
  return { pushRepository, repository, branch, baseBranch, pushOwner: target.push.owner };
}
