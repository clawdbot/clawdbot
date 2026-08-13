const GITHUB_HOST = "github.com";

export const GITHUB_HOVERCARD_OPEN_DELAY_MS = 250;

type GitHubItemTarget = {
  kind: "issue" | "pull";
  number: number;
  owner: string;
  repo: string;
};

export type GitHubLinkTarget = GitHubItemTarget & {
  href: string;
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

export function parseGitHubLinkTarget(href: string): GitHubLinkTarget | null {
  let url: URL;
  try {
    url = new URL(href, globalThis.location?.href ?? "http://localhost/");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== GITHUB_HOST) {
    return null;
  }
  if (url.username || url.password || (url.port && url.port !== "443")) {
    return null;
  }
  const target = parseGitHubItemPath(url);
  return target ? { ...target, href: url.href } : null;
}

export function formatGitHubItemReference(target: GitHubItemTarget): string {
  return `${target.owner}/${target.repo}#${target.number}`;
}

export function githubLinkAnchorFromEvent(event: Event): HTMLAnchorElement | null {
  for (const candidate of event.composedPath()) {
    if (candidate instanceof HTMLAnchorElement) {
      return candidate;
    }
    if (candidate === event.currentTarget) {
      break;
    }
  }
  return null;
}

export function isGitHubPullRequestLink(href: string): boolean {
  return parseGitHubLinkTarget(href)?.kind === "pull";
}
