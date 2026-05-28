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

function splitRef(url: string): { repo: string; ref?: string } {
  const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    const pathWithMaybeRef = scpLikeMatch[2] ?? "";
    const refSeparator = pathWithMaybeRef.indexOf("@");
    if (refSeparator < 0) {
      return { repo: url };
    }
    const repoPath = pathWithMaybeRef.slice(0, refSeparator);
    const ref = pathWithMaybeRef.slice(refSeparator + 1);
    if (!repoPath || !ref) {
      return { repo: url };
    }
    return {
      repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
      ref,
    };
  }

  if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
      const refSeparator = pathWithMaybeRef.indexOf("@");
      if (refSeparator < 0) {
        return { repo: url };
      }
      const repoPath = pathWithMaybeRef.slice(0, refSeparator);
      const ref = pathWithMaybeRef.slice(refSeparator + 1);
      if (!repoPath || !ref) {
        return { repo: url };
      }
      parsed.pathname = `/${repoPath}`;
      return {
        repo: parsed.toString().replace(/\/$/, ""),
        ref,
      };
    } catch {
      return { repo: url };
    }
  }

  const slashIndex = url.indexOf("/");
  if (slashIndex < 0) {
    return { repo: url };
  }
  const host = url.slice(0, slashIndex);
  const pathWithMaybeRef = url.slice(slashIndex + 1);
  const refSeparator = pathWithMaybeRef.indexOf("@");
  if (refSeparator < 0) {
    return { repo: url };
  }
  const repoPath = pathWithMaybeRef.slice(0, refSeparator);
  const ref = pathWithMaybeRef.slice(refSeparator + 1);
  if (!repoPath || !ref) {
    return { repo: url };
  }
  return {
    repo: `${host}/${repoPath}`,
    ref,
  };
}

function parseGenericGitUrl(url: string): GitSource | null {
  const { repo: repoWithoutRef, ref } = splitRef(url);
  let repo = repoWithoutRef;
  let host = "";
  let path = "";

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
    const info = hostedGitInfo.fromUrl(candidate);
    if (info) {
      if (split.ref && info.project?.includes("@")) {
        continue;
      }
      const host = info.domain || "";
      const path = normalizeGitPath(`${info.user}/${info.project}`);
      if (!isSafeGitHost(host) || !path) {
        continue;
      }
      const useHttpsPrefix =
        !split.repo.startsWith("http://") &&
        !split.repo.startsWith("https://") &&
        !split.repo.startsWith("ssh://") &&
        !split.repo.startsWith("git://") &&
        !split.repo.startsWith("git@");
      return {
        type: "git",
        repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
        host,
        path,
        ref: info.committish || split.ref || undefined,
        pinned: Boolean(info.committish || split.ref),
      };
    }
  }

  const httpsCandidates = [
    split.ref ? `https://${split.repo}#${split.ref}` : undefined,
    `https://${url}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of httpsCandidates) {
    const info = hostedGitInfo.fromUrl(candidate);
    if (info) {
      if (split.ref && info.project?.includes("@")) {
        continue;
      }
      const host = info.domain || "";
      const path = normalizeGitPath(`${info.user}/${info.project}`);
      if (!isSafeGitHost(host) || !path) {
        continue;
      }
      return {
        type: "git",
        repo: `https://${split.repo}`,
        host,
        path,
        ref: info.committish || split.ref || undefined,
        pinned: Boolean(info.committish || split.ref),
      };
    }
  }

  return parseGenericGitUrl(url);
}
