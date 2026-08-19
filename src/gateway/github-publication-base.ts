import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";

export function githubPublicationBaseLookupArgs(repository: string, baseBranch: string): string[] {
  return [
    "gh",
    "api",
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
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--recurse-submodules=no",
    "--",
    `https://github.com/${repository}.git`,
    sha,
  ];
}

export function githubPublicationBaseLineageArgs(ancestor: string, descendant: string): string[] {
  return ["git", "merge-base", "--is-ancestor", ancestor, descendant];
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
