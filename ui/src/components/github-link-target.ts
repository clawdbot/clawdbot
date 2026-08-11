export type GitHubItemTarget = {
  kind: "issue" | "pull";
  number: number;
  owner: string;
  repo: string;
};

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && decoded !== "." && decoded !== ".." ? decoded : null;
  } catch {
    return null;
  }
}

export function parseGitHubItemPath(url: URL): GitHubItemTarget | null {
  const segments = url.pathname.split("/").filter(Boolean);
  const owner = decodePathSegment(segments[0] ?? "");
  const repo = decodePathSegment(segments[1] ?? "");
  const surface = segments[2];
  const numberText = segments[3] ?? "";
  if (!owner || !repo || !/^[1-9]\d{0,9}$/.test(numberText)) {
    return null;
  }
  const kind = surface === "issues" ? "issue" : surface === "pull" ? "pull" : null;
  return kind ? { kind, number: Number(numberText), owner, repo } : null;
}

export function formatGitHubItemReference(target: GitHubItemTarget): string {
  return `${target.owner}/${target.repo}#${target.number}`;
}
