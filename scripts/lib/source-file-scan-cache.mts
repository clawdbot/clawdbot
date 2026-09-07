// Caches source file discovery and bounded-concurrency reads for guard scripts.
import { promises as fs } from "node:fs";
import path from "node:path";
import pMap from "p-map";

const DEFAULT_SOURCE_FILE_READ_CONCURRENCY = 32;
const DEFAULT_SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024;
type SourceScanParams = {
  repoRoot: string;
  scanRoots: string[];
  scanExtensions: Set<string>;
  ignoredDirNames: Set<string>;
  maxConcurrentReads?: number;
  maxFileBytes?: number;
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  statFile?: (filePath: string) => Promise<{ size: number }>;
};

type SourceFileContent = { filePath: string; relativeFile: string; content: string };
const scanCache = new Map<string, Promise<SourceFileContent[]>>();

function normalizeRepoPath(repoRoot: string, filePath: string) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

async function walkFiles(params: SourceScanParams, rootDir: string): Promise<string[]> {
  const out: string[] = [];
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

function normalizeConcurrency(value = DEFAULT_SOURCE_FILE_READ_CONCURRENCY) {
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_SOURCE_FILE_READ_CONCURRENCY;
  }
  return value;
}

function normalizeMaxFileBytes(value = DEFAULT_SOURCE_FILE_MAX_BYTES) {
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_SOURCE_FILE_MAX_BYTES;
  }
  return value;
}

function assertSourceFileWithinLimit(relativeFile: string, bytes: number, maxFileBytes: number) {
  if (bytes <= maxFileBytes) {
    return;
  }
  throw new Error(
    `source scan file exceeds ${maxFileBytes} byte limit: ${relativeFile} (${bytes} bytes)`,
  );
}

/**
 * Collects sorted source files and cached contents for configured scan roots.
 */
export async function collectSourceFileContents(params: SourceScanParams) {
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
      .map((filePath) => ({ filePath, relativeFile: normalizeRepoPath(params.repoRoot, filePath) }))
      .toSorted((left, right) => left.relativeFile.localeCompare(right.relativeFile));

    const readFile = params.readFile ?? fs.readFile;
    const statFile = params.statFile ?? fs.stat;
    const maxFileBytes = normalizeMaxFileBytes(params.maxFileBytes);
    return await pMap(
      files,
      async ({ filePath, relativeFile }) => {
        const stat = await statFile(filePath);
        assertSourceFileWithinLimit(relativeFile, stat.size, maxFileBytes);
        const content = await readFile(filePath, "utf8");
        assertSourceFileWithinLimit(relativeFile, Buffer.byteLength(content, "utf8"), maxFileBytes);
        return { filePath, relativeFile, content };
      },
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
