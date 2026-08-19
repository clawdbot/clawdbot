// Normalizes repository remotes for cloud-worker project profile selection.

/** Normalize a Git origin URL to a lowercase host/path repository identity. */
export function normalizeCloudRepo(originUrl: string): string | undefined {
  const value = originUrl.trim();
  if (!value) {
    return undefined;
  }

  let host: string;
  let repoPath: string;
  const scpLike = value.match(/^[^@\s]+@([^:\s]+):(.+)$/u);
  if (scpLike) {
    host = scpLike[1] ?? "";
    repoPath = scpLike[2] ?? "";
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return undefined;
    }
    if (!["git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) {
      return undefined;
    }
    host = parsed.hostname;
    repoPath = parsed.pathname;
  }

  const normalizedPath = repoPath.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
  const segments = normalizedPath.split("/");
  if (
    !host ||
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return `${host}/${segments.join("/")}`.toLowerCase();
}
