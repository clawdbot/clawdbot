import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_SOURCE_FILE_READ_CONCURRENCY = 32;
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

function normalizeConcurrency(value) {
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_SOURCE_FILE_READ_CONCURRENCY;
  }
  return value;
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const out = Array.from({ length: items.length });
  const workerCount = Math.min(normalizeConcurrency(concurrency), items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      out[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

export async function collectSourceFileContents(params) {
  const useCache = !params.readFile;
  const cacheKey = JSON.stringify({
    repoRoot: params.repoRoot,
    scanRoots: params.scanRoots,
    scanExtensions: [...params.scanExtensions].toSorted((left, right) => left.localeCompare(right)),
    ignoredDirNames: [...params.ignoredDirNames].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  });
  if (useCache) {
    const cached = scanCache.get(cacheKey);
    if (cached) {
      return await cached;
    }
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

    const readFile = params.readFile ?? fs.readFile;
    return await mapWithConcurrency(
      files,
      params.maxConcurrentReads,
      async (filePath) => ({
        filePath,
        relativeFile: normalizeRepoPath(params.repoRoot, filePath),
        content: await readFile(filePath, "utf8"),
      }),
    );
  })();

  if (useCache) {
    scanCache.set(cacheKey, promise);
  }
  try {
    return await promise;
  } catch (error) {
    if (useCache) {
      scanCache.delete(cacheKey);
    }
    throw error;
  }
}
