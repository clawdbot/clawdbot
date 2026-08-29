import fsPromises from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";

export async function assertLocalPathSafety(params: {
  target: { hostPath?: string; containerPath: string };
  root: string;
  allowMissingLeaf: boolean;
  allowFinalSymlinkForUnlink: boolean;
}): Promise<void> {
  if (!params.target.hostPath) {
    throw new Error(`Missing local host path for ${params.target.containerPath}`);
  }
  const canonicalRoot = await fsPromises
    .realpath(params.root)
    .catch(() => path.resolve(params.root));
  const targetStats = await fsPromises.lstat(params.target.hostPath).catch(() => null);
  const candidate =
    params.allowFinalSymlinkForUnlink && targetStats?.isSymbolicLink()
      ? path.resolve(canonicalRoot, path.relative(params.root, params.target.hostPath))
      : await resolveCanonicalCandidate(params.target.hostPath);
  if (!isPathInside(canonicalRoot, candidate)) {
    throw new Error(
      `Sandbox path escapes allowed mounts; cannot access: ${params.target.containerPath}`,
    );
  }

  const relative = path.relative(params.root, params.target.hostPath);
  const segments = relative.split(path.sep).filter(Boolean);
  let cursor = params.root;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const stats = await fsPromises.lstat(cursor).catch(() => null);
    if (!stats) {
      if (index === segments.length - 1 && params.allowMissingLeaf) {
        return;
      }
      continue;
    }
    const isFinal = index === segments.length - 1;
    if (stats.isSymbolicLink() && (!isFinal || !params.allowFinalSymlinkForUnlink)) {
      throw new Error(`Sandbox boundary checks failed: ${params.target.containerPath}`);
    }
  }
}

async function resolveCanonicalCandidate(targetPath: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path.resolve(targetPath);
  while (true) {
    const exists = await fsPromises
      .lstat(cursor)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const canonical = await fsPromises.realpath(cursor).catch(() => cursor);
      return path.resolve(canonical, ...missing);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return path.resolve(cursor, ...missing);
    }
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
}
