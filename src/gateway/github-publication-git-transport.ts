import os from "node:os";

const GITHUB_CREDENTIAL_ARGS = [
  "git",
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
] as const;

export function appendGitHubPublicationMessage(base: string, lines: readonly string[]): string {
  const present = new Set(base.split(/\r?\n/u).map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  return missing.length > 0 ? `${base.trimEnd()}\n\n${missing.join("\n")}` : base.trimEnd();
}

export async function assertGitHubPublicationBranchRef(
  branch: string,
  run: (argv: string[]) => Promise<number>,
): Promise<void> {
  const code = await run(["git", "symbolic-ref", "--quiet", `refs/heads/${branch}`]);
  if (code === 0) {
    throw new Error("GitHub publication workspace branch ref became symbolic.");
  }
  if (code !== 1) {
    throw new Error("GitHub publication workspace branch ref could not be verified.");
  }
}

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

export function githubPublicationUpdateRefArgs(
  branch: string,
  commit: string,
  previousHead: string,
): string[] {
  return [
    "git",
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "core.fsmonitor=false",
    "update-ref",
    `refs/heads/${branch}`,
    commit,
    previousHead,
  ];
}
