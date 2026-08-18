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

function parseGitHubItemPath(url: URL): GitHubItemTarget | null {
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

export function formatGitHubLinkLabel(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const item = parseGitHubItemPath(url);
  if (item && segments.length === 4 && !url.search && !url.hash) {
    return `#${item.number}`;
  }
  if (item) {
    return url.href;
  }
  if (segments.length === 2) {
    return segments.map((segment) => decodePathSegment(segment) ?? segment).join("/");
  }
  if (segments[2] === "blob" && segments.length > 4) {
    const filename = decodePathSegment(segments.at(-1) ?? "");
    if (filename) {
      return filename;
    }
  }
  const fallbackSegments = segments.length > 2 ? segments.slice(2) : segments;
  const path = fallbackSegments.map((segment) => decodePathSegment(segment) ?? segment);
  return ["github.com", ...path].join("/");
}

export function gitHubProfileUrl(login: string): string {
  return `https://${GITHUB_HOST}/${encodeURIComponent(login)}`;
}

// Built from the parsed parts rather than the source href, which isGitHubItemRootPath
// shows may already carry its own sub-path, query, or comment fragment.
export function gitHubFilesChangedUrl(target: GitHubItemTarget): string {
  const repoPath = `${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  return `https://${GITHUB_HOST}/${repoPath}/pull/${target.number}/files`;
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
