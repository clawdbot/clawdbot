import { promises as fs } from "node:fs";
import path from "node:path";

const scanCache = new Map();

function normalizeRepoPath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

async function walkFiles(params, rootDir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return out;
    }
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!params.ignoredDirNames.has(entry.name)) {
        out.push(...(await walkFiles(params, entryPath)));
      }
      continue;
    }
    if (entry.isFile() && params.scanExtensions.has(path.extname(entry.name))) {
      out.push(entryPath);
    }
  }
  return out;
}

export async function collectSourceFileContents(params) {
  const cacheKey = JSON.stringify({
    repoRoot: params.repoRoot,
    scanRoots: params.scanRoots,
    scanExtensions: [...params.scanExtensions].toSorted((left, right) => left.localeCompare(right)),
    ignoredDirNames: [...params.ignoredDirNames].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  });
  const cached = scanCache.get(cacheKey);
  if (cached) {
    return await cached;
  }

  const promise = (async () => {
    const files = (
      await Promise.all(
        params.scanRoots.map(async (root) => walkFiles(params, path.join(params.repoRoot, root))),
      )
    )
      .flat()
      .toSorted((left, right) =>
        normalizeRepoPath(params.repoRoot, left).localeCompare(
          normalizeRepoPath(params.repoRoot, right),
        ),
      );

    return await Promise.all(
      files.map(async (filePath) => ({
        filePath,
        relativeFile: normalizeRepoPath(params.repoRoot, filePath),
        content: await fs.readFile(filePath, "utf8"),
      })),
    );
  })();

  scanCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    scanCache.delete(cacheKey);
    throw error;
  }
}
