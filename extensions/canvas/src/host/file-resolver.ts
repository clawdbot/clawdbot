import path from "node:path";
import { root as fsRoot, FsSafeError } from "openclaw/plugin-sdk/security-runtime";

type CanvasOpenResult = Awaited<ReturnType<Awaited<ReturnType<typeof fsRoot>>["open"]>>;

export function normalizeUrlPath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath || "/");
  const normalized = path.posix.normalize(decoded);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function pathEscapesRoot(decodedPath: string): boolean {
  let depth = 0;
  for (const segment of decodedPath.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (depth === 0) {
        return true;
      }
      depth--;
      continue;
    }
    depth++;
  }
  return false;
}

function tryNormalizeUrlPath(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath || "/");
  } catch {
    return null;
  }
  if (pathEscapesRoot(decoded)) {
    return null;
  }
  const normalized = path.posix.normalize(decoded);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export async function resolveFileWithinRoot(
  rootReal: string,
  urlPath: string,
): Promise<CanvasOpenResult | null> {
  const normalized = tryNormalizeUrlPath(urlPath);
  if (normalized === null) {
    return null;
  }
  const rel = normalized.replace(/^\/+/, "");
  if (rel.split("/").some((p) => p === "..")) {
    return null;
  }
  const root = await fsRoot(rootReal);

  const tryOpen = async (relative: string) => {
    try {
      return await root.open(relative);
    } catch (err) {
      if (err instanceof FsSafeError) {
        return null;
      }
      throw err;
    }
  };

  if (normalized.endsWith("/")) {
    return await tryOpen(path.posix.join(rel, "index.html"));
  }

  try {
    const st = await root.stat(rel);
    if (st.isSymbolicLink) {
      return null;
    }
    if (st.isDirectory) {
      return await tryOpen(path.posix.join(rel, "index.html"));
    }
  } catch (err) {
    if (err instanceof FsSafeError) {
      return null;
    }
    throw err;
  }

  return await tryOpen(rel);
}
