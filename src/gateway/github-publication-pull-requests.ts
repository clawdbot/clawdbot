import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";

type GitHubPublicationPullRequest = {
  userId: number;
  url: string;
  state: "open" | "closed";
  body: string;
  headSha: string;
  headRef: string;
  baseRef: string;
};

export function githubPublicationPullRequestLookupArgs(params: {
  repository: string;
  owner: string;
  branch: string;
  baseBranch: string;
}): string[] {
  return [
    "gh",
    "api",
    "--method",
    "GET",
    `repos/${params.repository}/pulls`,
    "-f",
    `head=${params.owner}:${params.branch}`,
    "-f",
    `base=${params.baseBranch}`,
    "-f",
    "state=all",
    "--jq",
    'map({url: .html_url, userId: .user.id, state: .state, body: (.body // ""), headSha: .head.sha, headRef: .head.ref, baseRef: .base.ref})',
  ];
}

/** Parses the complete authenticated PR lookup; one malformed candidate invalidates the response. */
export function parseGitHubPublicationPullRequests(raw: string): GitHubPublicationPullRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("GitHub pull request lookup returned invalid JSON.", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub pull request lookup returned an invalid response.");
  }
  return parsed.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error("GitHub pull request lookup returned an invalid candidate.");
    }
    const userId = candidate.userId;
    const url = readNonBlankString(candidate.url);
    const state = candidate.state;
    const body = candidate.body;
    const headSha = readNonBlankString(candidate.headSha);
    const headRef = readNonBlankString(candidate.headRef);
    const baseRef = readNonBlankString(candidate.baseRef);
    if (
      !Number.isSafeInteger(userId) ||
      Number(userId) < 1 ||
      !url ||
      (state !== "open" && state !== "closed") ||
      typeof body !== "string" ||
      !headSha ||
      !headRef ||
      !baseRef
    ) {
      throw new Error("GitHub pull request lookup returned an invalid candidate.");
    }
    return { userId: Number(userId), url, state, body, headSha, headRef, baseRef };
  });
}
