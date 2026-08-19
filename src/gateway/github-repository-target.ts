import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";

type GitHubRepositoryRef = {
  owner: string;
  repo: string;
};

type GitHubRepositoryTarget = {
  fork: boolean;
  push: GitHubRepositoryRef;
  pullRequest: GitHubRepositoryRef & { defaultBranch: string };
};

/** Projects GitHub's repository response into the canonical push/head/base relationship. */
export function resolveGitHubRepositoryTarget(
  value: unknown,
  push: GitHubRepositoryRef,
): GitHubRepositoryTarget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const defaultBranch = readNonBlankString(value.default_branch)?.trim();
  if (value.fork !== true) {
    return defaultBranch
      ? { fork: false, push, pullRequest: { ...push, defaultBranch } }
      : undefined;
  }
  if (!isRecord(value.parent)) {
    return undefined;
  }
  const parentOwner = isRecord(value.parent.owner) ? value.parent.owner : undefined;
  const owner = readNonBlankString(parentOwner?.login)?.trim();
  const repo = readNonBlankString(value.parent.name)?.trim();
  const parentDefaultBranch = readNonBlankString(value.parent.default_branch)?.trim();
  return owner && repo && parentDefaultBranch
    ? {
        fork: true,
        push,
        pullRequest: { owner, repo, defaultBranch: parentDefaultBranch },
      }
    : undefined;
}
