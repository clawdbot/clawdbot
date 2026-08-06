// Caches source file discovery and bounded-concurrency reads for guard scripts.
import { promises as fs } from "node:fs";
import path from "node:path";
import pMap from "p-map";

const DEFAULT_SOURCE_FILE_READ_CONCURRENCY = 32;
const DEFAULT_SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const scanCache = new Map();

function normalizeRepoPath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

async function walkFiles(params, rootDir) {
  const out = [];
  let entries;
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

function normalizeMaxFileBytes(value) {
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_SOURCE_FILE_MAX_BYTES;
  }
  return value;
}

function assertSourceFileWithinLimit(relativeFile, bytes, maxFileBytes) {
  if (bytes <= maxFileBytes) {
    return;
  }
  throw new Error(
    `source scan file exceeds ${maxFileBytes} byte limit: ${relativeFile} (${bytes} bytes)`,
  );
}

async function readBoundedSourceFile(params, filePath, readFile, statFile, maxFileBytes) {
  const relativeFile = normalizeRepoPath(params.repoRoot, filePath);
  const stat = await statFile(filePath);
  assertSourceFileWithinLimit(relativeFile, stat.size, maxFileBytes);
  const content = await readFile(filePath, "utf8");
  assertSourceFileWithinLimit(relativeFile, Buffer.byteLength(content, "utf8"), maxFileBytes);
  return {
    filePath,
    relativeFile,
    content,
  };
}

/**
 * Collects sorted source files and cached contents for configured scan roots.
 */
export async function collectSourceFileContents(params) {
  const useCache = !params.readFile;
  const cacheKey = JSON.stringify({
    repoRoot: params.repoRoot,
    scanRoots: params.scanRoots,
    scanExtensions: [...params.scanExtensions].toSorted((left, right) => left.localeCompare(right)),
    ignoredDirNames: [...params.ignoredDirNames].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    maxFileBytes: normalizeMaxFileBytes(params.maxFileBytes),
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
    const statFile = params.statFile ?? fs.stat;
    const maxFileBytes = normalizeMaxFileBytes(params.maxFileBytes);
    return await pMap(
      files,
      async (filePath) => readBoundedSourceFile(params, filePath, readFile, statFile, maxFileBytes),
      {
        concurrency: normalizeConcurrency(params.maxConcurrentReads),
        stopOnError: true,
      },
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
