import os from "node:os";

const GITHUB_CREDENTIAL_ARGS = [
  "git",
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
] as const;

export function githubPublicationPushArgs(
  remote: string,
  headCommit: string,
  branch: string,
): string[] {
  return [
    ...GITHUB_CREDENTIAL_ARGS,
    "push",
    "--porcelain",
    "--no-follow-tags",
    "--recurse-submodules=no",
    "--",
    remote,
    `${headCommit}:refs/heads/${branch}`,
  ];
}

export function githubPublicationRemoteHeadArgs(remote: string, branch: string): string[] {
  return [...GITHUB_CREDENTIAL_ARGS, "ls-remote", "--refs", remote, `refs/heads/${branch}`];
}

export function githubPublicationResetIndexArgs(headCommit: string): string[] {
  return [
    "git",
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "core.fsmonitor=false",
    "reset",
    "--mixed",
    "--quiet",
    headCommit,
  ];
}
