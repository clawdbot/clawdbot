import hostedGitInfo from "hosted-git-info";

/**
 * Parsed git URL information.
 */
export type GitSource = {
  /** Always "git" for git sources */
  type: "git";
  /** Clone URL (always valid for git clone, without ref suffix) */
  repo: string;
  /** Git host domain (e.g., "github.com") */
  host: string;
  /** Repository path (e.g., "user/repo") */
  path: string;
  /** Git ref (branch, tag, commit) if specified */
  ref?: string;
  /** True if ref was specified (package won't be auto-updated) */
  pinned: boolean;
};

function splitPathRef(params: {
  originalRepo: string;
  pathWithMaybeRef: string;
  buildRepo: (repoPath: string) => string;
}): { repo: string; ref?: string } {
  const refSeparator = params.pathWithMaybeRef.indexOf("@");
  if (refSeparator < 0) {
    return { repo: params.originalRepo };
  }
  const repoPath = params.pathWithMaybeRef.slice(0, refSeparator);
  const ref = params.pathWithMaybeRef.slice(refSeparator + 1);
  if (!repoPath || !ref) {
    return { repo: params.originalRepo };
  }
  return {
    repo: params.buildRepo(repoPath),
    ref,
  };
}

function splitRef(url: string): { repo: string; ref?: string } {
  const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    return splitPathRef({
      originalRepo: url,
      pathWithMaybeRef: scpLikeMatch[2] ?? "",
      buildRepo: (repoPath) => `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
    });
  }

  if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      return splitPathRef({
        originalRepo: url,
        pathWithMaybeRef: parsed.pathname.replace(/^\/+/, ""),
        buildRepo: (repoPath) => {
          parsed.pathname = `/${repoPath}`;
          return parsed.toString().replace(/\/$/, "");
        },
      });
    } catch {
      return { repo: url };
    }
  }

  const slashIndex = url.indexOf("/");
  if (slashIndex < 0) {
    return { repo: url };
  }
  const host = url.slice(0, slashIndex);
  return splitPathRef({
    originalRepo: url,
    pathWithMaybeRef: url.slice(slashIndex + 1),
    buildRepo: (repoPath) => `${host}/${repoPath}`,
  });
}

function parseGenericGitUrl(url: string): GitSource | null {
  const { repo: repoWithoutRef, ref } = splitRef(url);
  let repo = repoWithoutRef;
  let host;
  let path;

  const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    host = scpLikeMatch[1] ?? "";
    path = scpLikeMatch[2] ?? "";
  } else if (
    repoWithoutRef.startsWith("https://") ||
    repoWithoutRef.startsWith("http://") ||
    repoWithoutRef.startsWith("ssh://") ||
    repoWithoutRef.startsWith("git://")
  ) {
    try {
      const parsed = new URL(repoWithoutRef);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else {
    const slashIndex = repoWithoutRef.indexOf("/");
    if (slashIndex < 0) {
      return null;
    }
    host = repoWithoutRef.slice(0, slashIndex);
    path = repoWithoutRef.slice(slashIndex + 1);
    if (!host.includes(".") && host !== "localhost") {
      return null;
    }
    repo = `https://${repoWithoutRef}`;
  }

  const normalizedPath = normalizeGitPath(path);
  if (!isSafeGitHost(host) || !normalizedPath) {
    return null;
  }

  return {
    type: "git",
    repo,
    host,
    path: normalizedPath,
    ref,
    pinned: Boolean(ref),
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

function resolveHostedGitSource(params: {
  candidate: string;
  split: { repo: string; ref?: string };
  repo: string;
}): GitSource | null {
  const info = hostedGitInfo.fromUrl(params.candidate);
  if (!info) {
    return null;
  }
  if (params.split.ref && info.project?.includes("@")) {
    return null;
  }
  const host = info.domain || "";
  const path = normalizeGitPath(`${info.user}/${info.project}`);
  if (!isSafeGitHost(host) || !path) {
    return null;
  }
  return {
    type: "git",
    repo: params.repo,
    host,
    path,
    ref: info.committish || params.split.ref || undefined,
    pinned: Boolean(info.committish || params.split.ref),
  };
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

  const split = splitRef(url);

  const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : undefined, url].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of hostedCandidates) {
    const useHttpsPrefix =
      !split.repo.startsWith("http://") &&
      !split.repo.startsWith("https://") &&
      !split.repo.startsWith("ssh://") &&
      !split.repo.startsWith("git://") &&
      !split.repo.startsWith("git@");
    const parsed = resolveHostedGitSource({
      candidate,
      split,
      repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
    });
    if (parsed) {
      return parsed;
    }
  }

  const httpsCandidates = [
    split.ref ? `https://${split.repo}#${split.ref}` : undefined,
    `https://${url}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of httpsCandidates) {
    const parsed = resolveHostedGitSource({
      candidate,
      split,
      repo: `https://${split.repo}`,
    });
    if (parsed) {
      return parsed;
    }
  }

  return parseGenericGitUrl(url);
}
