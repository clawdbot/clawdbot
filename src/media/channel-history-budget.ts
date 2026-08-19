import fs from "node:fs/promises";
import path from "node:path";

/** Matches the default persisted channel-history time window. */
export const CHANNEL_HISTORY_MEDIA_TTL_MS = 24 * 60 * 60_000;
/** Aggregate fixed budget for restart-safe channel-history attachments. */
const CHANNEL_HISTORY_MEDIA_MAX_BYTES = 512 * 1024 * 1024;
/** Aggregate fixed file-count budget for restart-safe channel-history attachments. */
const CHANNEL_HISTORY_MEDIA_MAX_FILES = 4096;

type ChannelHistoryMediaLimits = {
  maxBytes: number;
  maxFiles: number;
  ttlMs: number;
};

type ChannelHistoryMediaFile = {
  relativePath: string;
  size: number;
  mtimeMs: number;
};

type ChannelHistoryMediaBudgetDeps = {
  resolveDir: () => string;
  pruneExpired: (dir: string, ttlMs: number) => Promise<void>;
  remove: (dir: string, relativePath: string) => Promise<void>;
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function listFiles(dir: string, relativeDir = ""): Promise<ChannelHistoryMediaFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
  const files: ChannelHistoryMediaFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = await fs.lstat(absolutePath).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    });
    if (stat?.isFile()) {
      files.push({ relativePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return files;
}

/** Owns serialized publication, TTL cleanup, and aggregate quotas for pending-history media. */
export function createChannelHistoryMediaBudget(deps: ChannelHistoryMediaBudgetDeps) {
  let operationTail = Promise.resolve();
  let limitsForTest: ChannelHistoryMediaLimits | undefined;

  const resolveLimits = (): ChannelHistoryMediaLimits =>
    limitsForTest ?? {
      maxBytes: CHANNEL_HISTORY_MEDIA_MAX_BYTES,
      maxFiles: CHANNEL_HISTORY_MEDIA_MAX_FILES,
      ttlMs: CHANNEL_HISTORY_MEDIA_TTL_MS,
    };

  const pruneToLimits = async (): Promise<void> => {
    const dir = deps.resolveDir();
    const limits = resolveLimits();
    await deps.pruneExpired(dir, limits.ttlMs);
    const files = (await listFiles(dir)).toSorted(
      (left, right) =>
        left.mtimeMs - right.mtimeMs || left.relativePath.localeCompare(right.relativePath),
    );
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    let totalFiles = files.length;
    for (const file of files) {
      if (totalBytes <= limits.maxBytes && totalFiles <= limits.maxFiles) {
        break;
      }
      await deps.remove(dir, file.relativePath);
      totalBytes -= file.size;
      totalFiles -= 1;
    }
  };

  const queue = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = operationTail.then(operation);
    operationTail = run.then(
      () => {},
      () => {},
    );
    return await run;
  };

  return {
    async publish<T>(params: {
      publish: () => Promise<T>;
      resolvePath: (result: T) => string;
    }): Promise<T> {
      return await queue(async () => {
        const result = await params.publish();
        const publishedPath = params.resolvePath(result);
        try {
          await pruneToLimits();
          const stat = await fs.lstat(publishedPath);
          if (!stat.isFile()) {
            throw new Error("channel-history media publication is not a regular file");
          }
          return result;
        } catch (error) {
          await fs.unlink(publishedPath).catch(() => undefined);
          throw new Error("channel-history media publication exceeded its fixed storage budget", {
            cause: error,
          });
        }
      });
    },
    async enforce(this: void): Promise<void> {
      await queue(pruneToLimits);
    },
    setLimitsForTest(
      this: void,
      limits?: { maxBytes: number; maxFiles: number; ttlMs?: number },
    ): void {
      limitsForTest = limits
        ? {
            maxBytes: limits.maxBytes,
            maxFiles: limits.maxFiles,
            ttlMs: limits.ttlMs ?? CHANNEL_HISTORY_MEDIA_TTL_MS,
          }
        : undefined;
    },
  };
}
