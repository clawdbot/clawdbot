import os from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";

export function githubPublicationBaseLookupArgs(repository: string, baseBranch: string): string[] {
  return [
    "gh",
    "api",
    "--hostname",
    "github.com",
    `repos/${repository}/git/ref/heads/${baseBranch}`,
    "--jq",
    "{ref: .ref, sha: .object.sha}",
  ];
}

export function githubPublicationBaseFetchArgs(repository: string, sha: string): string[] {
  return [
    "git",
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    "fetch",
    "--no-auto-maintenance",
    "--no-tags",
    "--no-write-fetch-head",
    "--recurse-submodules=no",
    "--",
    `https://github.com/${repository}.git`,
    sha,
  ];
}

export function githubPublicationBranchCreationArgs(branch: string): string[] {
  return ["git", "reflog", "show", "--format=%H", "--end-of-options", `refs/heads/${branch}`];
}

export function githubPublicationBaseLineageArgs(ancestor: string, descendant: string): string[] {
  return ["git", "merge-base", "--is-ancestor", ancestor, descendant];
}

export function githubPublicationUnsafeConfigArgs(scope: "--local" | "--worktree"): string[] {
  return [
    "git",
    "config",
    scope,
    "--includes",
    "--get-regexp",
    "^(core\\.(alternaterefscommand|askpass|fsmonitor|gitproxy|sshcommand|worktree)|credential\\..*helper|filter\\..*|http\\..*|include(if)?\\..*|push\\..*|remote\\..*\\.(proxy|receivepack|uploadpack|vcs)|uploadpack\\.packobjectshook|url\\..*\\.(insteadof|pushinsteadof))$",
  ];
}

export function parseGitHubPublicationBaseBranch(baseRef: string, defaultBranch: string): string {
  const trimmed = baseRef.trim();
  if (!trimmed || trimmed === "HEAD" || /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(trimmed)) {
    return defaultBranch;
  }
  for (const prefix of ["refs/remotes/origin/", "origin/", "refs/heads/"]) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

/** Returns the authenticated target-base SHA or fails the publication boundary closed. */
export function parseGitHubPublicationBaseRef(raw: string, baseBranch: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GitHub publication workspace base branch could not be verified.");
  }
  const ref = isRecord(parsed) ? readNonBlankString(parsed.ref) : undefined;
  const sha = isRecord(parsed) ? readNonBlankString(parsed.sha) : undefined;
  if (
    ref !== `refs/heads/${baseBranch}` ||
    !sha ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(sha)
  ) {
    throw new Error("GitHub publication workspace base branch could not be verified.");
  }
  return sha;
}
