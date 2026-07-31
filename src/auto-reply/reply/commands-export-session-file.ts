// Owns the filesystem boundary for session-export artifacts.
import path from "node:path";
import { FsSafeError, isPathInside, root, type Root } from "../../infra/fs-safe.js";

const MAX_DEFAULT_FILENAME_ATTEMPTS = 100;

function addCollisionSuffix(filePath: string, suffix: number): string {
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  return path.join(path.dirname(filePath), `${baseName}-${suffix}${ext}`);
}

async function createUnusedFile(
  workspaceRoot: Root,
  filePath: string,
  contents: string,
): Promise<string> {
  for (let suffix = 1; suffix <= MAX_DEFAULT_FILENAME_ATTEMPTS; suffix++) {
    const candidate = suffix === 1 ? filePath : addCollisionSuffix(filePath, suffix);
    try {
      await workspaceRoot.create(candidate, contents, { encoding: "utf-8" });
      return candidate;
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "already-exists") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not find an unused export filename near ${filePath}`);
}

function normalizeWorkspaceAliasPath(workspaceRoot: Root, requestedPath: string): string {
  if (!path.isAbsolute(requestedPath)) {
    return requestedPath;
  }
  const normalizedRequest = path.resolve(requestedPath);
  if (!isPathInside(workspaceRoot.rootDir, normalizedRequest)) {
    return requestedPath;
  }
  const relativePath = path.relative(workspaceRoot.rootDir, normalizedRequest);
  return relativePath || requestedPath;
}

export async function writeSessionExportFile(params: {
  workspaceDir: string;
  requestedPath?: string;
  defaultFileName: string;
  contents: string;
}): Promise<{ absolutePath: string; displayPath: string }> {
  const workspaceRoot = await root(params.workspaceDir, { mkdir: true, mode: 0o600 });

  let writtenPath: string;
  if (params.requestedPath) {
    // Explicit regular files retain overwrite behavior. Rebase only lexical workspace
    // aliases onto the canonical Root; nested aliases, symlinks, and outside paths
    // still reach fs-safe unchanged and are blocked.
    writtenPath = normalizeWorkspaceAliasPath(workspaceRoot, params.requestedPath);
    await workspaceRoot.write(writtenPath, params.contents, { encoding: "utf-8" });
  } else {
    writtenPath = await createUnusedFile(workspaceRoot, params.defaultFileName, params.contents);
  }

  const absolutePath = await workspaceRoot.resolve(writtenPath);
  const relativePath = path.relative(workspaceRoot.rootReal, absolutePath);
  return {
    absolutePath,
    displayPath: relativePath.startsWith("..") ? absolutePath : relativePath,
  };
}
