/**
 * Git source parsing helpers.
 *
 * Normalizes git-style package references into host/path identity.
 */
import hostedGitInfo from "hosted-git-info";

/** Parsed git URL information. */
export type GitSource = {
  /** Always "git" for git sources */
  type: "git";
  /** Git host domain (e.g., "github.com") */
  host: string;
  /** Repository path (e.g., "user/repo") */
  path: string;
};

function stripRef(url: string): string {
  const protocolIndex = url.indexOf("://");
  // Package refs use @ only after the repository path starts; credential @ signs stay intact.
  const pathStart = url.startsWith("git@")
    ? url.indexOf(":") + 1
    : url.indexOf("/", protocolIndex < 0 ? 0 : protocolIndex + 3) + 1;
  if (pathStart <= 0) {
    return url;
  }
  const suffixOffset = url.slice(pathStart).search(/[?#]/);
  const pathEnd = suffixOffset < 0 ? url.length : pathStart + suffixOffset;
  let refSeparator = url.indexOf("@", pathStart);
  if (refSeparator === pathStart) {
    refSeparator = url.indexOf("@", pathStart + 1);
  }
  if (refSeparator <= pathStart || refSeparator === pathEnd - 1 || refSeparator >= pathEnd) {
    return url;
  }
  return protocolIndex < 0
    ? url.slice(0, refSeparator)
    : url.slice(0, refSeparator) + url.slice(pathEnd);
}

function hasUnsafePathSegments(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? "";
  return path.includes("\\") || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(path);
}

function parseGenericGitUrl(url: string): GitSource | null {
  let host;
  let path;

  const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    host = scpLikeMatch[1] ?? "";
    path = scpLikeMatch[2] ?? "";
  } else if (/^(?:https?|ssh|git):\/\//.test(url)) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else {
    const slashIndex = url.indexOf("/");
    if (slashIndex < 0) {
      return null;
    }
    host = url.slice(0, slashIndex);
    path = url.slice(slashIndex + 1);
    if (!host.includes(".") && host !== "localhost") {
      return null;
    }
  }

  const normalizedPath = normalizeGitPath(path);
  if (!isSafeGitHost(host) || !normalizedPath) {
    return null;
  }

  return {
    type: "git",
    host,
    path: normalizedPath,
  };
}

function isSafeGitHost(host: string): boolean {
  return (
    Boolean(host) && !host.includes("/") && !host.includes("\\") && host !== "." && host !== ".."
  );
}

function normalizeGitPath(path: string): string | null {
  const normalizedPath = path.replace(/\.git$/, "").replace(/^\/+/, "");
  const segments = normalizedPath.split("/");
  if (segments.length < 2) {
    return null;
  }
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"),
    )
  ) {
    return null;
  }
  return segments.join("/");
}

function parseHostedGitUrl(url: string): GitSource | null {
  const candidates = [url];
  if (!url.includes("://") && !url.startsWith("git@")) {
    candidates.push(`https://${url}`);
  }

  for (const candidate of candidates) {
    const info = hostedGitInfo.fromUrl(candidate);
    if (!info) {
      continue;
    }
    const host = info.domain || "";
    const path = normalizeGitPath(`${info.user}/${info.project}`);
    if (isSafeGitHost(host) && path) {
      return { type: "git", host, path };
    }
  }
  return null;
}

/**
 * Parse git source into a GitSource.
 *
 * Rules:
 * - With git: prefix, accept all historical shorthand forms.
 * - Without git: prefix, only accept explicit protocol URLs.
 */
export function parseGitUrl(source: string): GitSource | null {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith("git:");
  const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

  if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
    return null;
  }

  const urlWithoutRef = stripRef(url);
  if (hasUnsafePathSegments(urlWithoutRef)) {
    return null;
  }
  return parseHostedGitUrl(urlWithoutRef) ?? parseGenericGitUrl(urlWithoutRef);
}
