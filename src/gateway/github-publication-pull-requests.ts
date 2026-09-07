import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { GitHubPublicationKnownFailure } from "./github-publication-failure.js";
import { requirePublicationCommand } from "./github-publication-git-transport.js";

type GitHubPublicationPullRequest = {
  userId: number;
  url: string;
  state: "open" | "closed";
  body: string;
  headSha: string;
  headRef: string;
  baseRef: string;
};

function githubPublicationPullRequestLookupArgs(params: {
  repository: string;
  owner: string;
  branch: string;
  baseBranch: string;
}): string[] {
  return [
    "gh",
    "api",
    "--hostname",
    "github.com",
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

export function githubPublicationCreatePullRequestArgs(repository: string): string[] {
  return [
    "gh",
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    `repos/${repository}/pulls`,
    "--input",
    "-",
  ];
}

/** Parses the complete authenticated PR lookup; one malformed candidate invalidates the response. */
function parseGitHubPublicationPullRequests(raw: string): GitHubPublicationPullRequest[] {
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

function resolveGitHubPublicationPullRequest(
  candidates: readonly GitHubPublicationPullRequest[],
  params: {
    accountId: number;
    headCommit: string;
    branch: string;
    baseBranch: string;
    marker: string;
  },
): GitHubPublicationPullRequest | undefined {
  const exact = candidates.filter(
    (candidate) =>
      candidate.userId === params.accountId &&
      candidate.headSha === params.headCommit &&
      candidate.headRef === params.branch &&
      candidate.baseRef === params.baseBranch,
  );
  const open = exact.find((candidate) => candidate.state === "open");
  return (
    open ??
    exact.find(
      (candidate) => candidate.state === "closed" && candidate.body.includes(params.marker),
    )
  );
}

export async function findGitHubPublicationPullRequest(params: {
  repository: string;
  pushOwner: string;
  branch: string;
  baseBranch: string;
  headCommit: string;
  marker: string;
  refreshIdentity: () => Promise<PreparedGitHubPublicationIdentity>;
  recordObserved: (url: string) => void;
  assertCurrent: () => void;
}): Promise<string | undefined> {
  const identity = await params.refreshIdentity();
  const raw = await requirePublicationCommand(
    githubPublicationPullRequestLookupArgs({
      repository: params.repository,
      owner: params.pushOwner,
      branch: params.branch,
      baseBranch: params.baseBranch,
    }),
    { env: identity.env },
  );
  const candidates = parseGitHubPublicationPullRequests(raw);
  const found = resolveGitHubPublicationPullRequest(candidates, {
    accountId: identity.account.accountId,
    headCommit: params.headCommit,
    branch: params.branch,
    baseBranch: params.baseBranch,
    marker: params.marker,
  });
  if (found) {
    params.recordObserved(found.url);
    params.assertCurrent();
    if (found.state === "closed") {
      throw new GitHubPublicationKnownFailure(
        "GitHub pull request was closed before publication completed.",
        {
          code: "github_rejected",
          nextAction:
            "Reopen the closed pull request or retry to create a new publication request.",
        },
      );
    }
  }
  const occupied = candidates.find(
    (candidate) =>
      candidate.state === "open" &&
      candidate.headRef === params.branch &&
      candidate.baseRef === params.baseBranch,
  );
  if (occupied && occupied.userId !== identity.account.accountId) {
    throw new GitHubPublicationKnownFailure("GitHub pull request is owned by another account.", {
      code: "github_rejected",
      nextAction: "Check pull-request permission for the effective account, then retry.",
    });
  }
  params.assertCurrent();
  return found?.url;
}
