import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";

type GitHubPublicationPullRequest = {
  userId: number;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
};

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
    const headSha = readNonBlankString(candidate.headSha);
    const headRef = readNonBlankString(candidate.headRef);
    const baseRef = readNonBlankString(candidate.baseRef);
    if (
      !Number.isSafeInteger(userId) ||
      Number(userId) < 1 ||
      !url ||
      !headSha ||
      !headRef ||
      !baseRef
    ) {
      throw new Error("GitHub pull request lookup returned an invalid candidate.");
    }
    return { userId: Number(userId), url, headSha, headRef, baseRef };
  });
}
