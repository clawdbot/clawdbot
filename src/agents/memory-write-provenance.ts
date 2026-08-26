import { realpathSync } from "node:fs";
import path from "node:path";
import { isMissingPathError } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import {
  clearMemoryArtifactProvenance,
  normalizeMemoryArtifactRelativePath,
  recordMemoryArtifactWriteProvenance,
} from "../memory/memory-artifact-provenance.js";

export type MemoryWriteProvenanceObserver = {
  classifies: (absolutePath: string) => boolean;
  write: (params: {
    absolutePath: string;
    contentBefore: string;
    contentAfter: string;
    commit: () => Promise<void>;
  }) => Promise<void>;
  clearAfterDelete: (absolutePath: string, contentBefore: string) => Promise<void>;
};

type ProvenanceWriteOperations = {
  readFile: (absolutePath: string) => Promise<Buffer | string>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  remove?: (absolutePath: string) => Promise<void>;
};

export function withMemoryWriteProvenance<T extends ProvenanceWriteOperations>(
  operations: T,
  observer: MemoryWriteProvenanceObserver | undefined,
): T {
  if (!observer) {
    return operations;
  }
  const remove = operations.remove;
  return {
    ...operations,
    writeFile: async (absolutePath: string, content: string) => {
      if (!observer.classifies(absolutePath)) {
        await operations.writeFile(absolutePath, content);
        return;
      }
      const contentBefore = await operations
        .readFile(absolutePath)
        .then((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value))
        .catch((error: unknown) => {
          if (!isMissingPathError(error)) {
            throw error;
          }
          return "";
        });
      await observer.write({
        absolutePath,
        contentBefore,
        contentAfter: content,
        commit: () => operations.writeFile(absolutePath, content),
      });
    },
    ...(remove
      ? {
          remove: async (absolutePath: string) => {
            const contentBefore = observer.classifies(absolutePath)
              ? await operations
                  .readFile(absolutePath)
                  .then((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value))
                  .catch((error: unknown) => {
                    if (!isMissingPathError(error)) {
                      throw error;
                    }
                    return "";
                  })
              : "";
            await remove(absolutePath);
            await observer.clearAfterDelete(absolutePath, contentBefore);
          },
        }
      : {}),
  } as T;
}

function resolveMemoryRelativePath(root: string, absolutePath: string): string | undefined {
  const canonicalPath = (candidate: string) => {
    try {
      return realpathSync.native(candidate);
    } catch {
      return path.join(realpathSync.native(path.dirname(candidate)), path.basename(candidate));
    }
  };
  const relativePath = path.relative(canonicalPath(root), canonicalPath(absolutePath));
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return undefined;
  }
  return normalizeMemoryArtifactRelativePath(relativePath.replaceAll(path.sep, "/"));
}

export function createMemoryWriteProvenanceObserver(params: {
  mutationRoot: string;
  workspaceDir: string;
  resolveOriginClass: () => "agent" | "untrusted";
  now?: () => number;
}): MemoryWriteProvenanceObserver {
  const now = params.now ?? Date.now;
  return {
    classifies: (absolutePath) =>
      resolveMemoryRelativePath(params.mutationRoot, absolutePath) !== undefined,
    write: async ({ absolutePath, contentBefore, contentAfter, commit }) => {
      const relativePath = resolveMemoryRelativePath(params.mutationRoot, absolutePath);
      if (!relativePath) {
        await commit();
        return;
      }
      const rollback = await recordMemoryArtifactWriteProvenance({
        workspaceDir: params.workspaceDir,
        relativePath,
        contentBefore,
        contentAfter,
        originClass: params.resolveOriginClass(),
        observedAt: now(),
      });
      try {
        await commit();
      } catch (error) {
        try {
          await rollback?.();
        } catch (rollbackError) {
          throw new Error(
            `File write failed and memory provenance rollback also failed: ${String(error)}`,
            { cause: rollbackError },
          );
        }
        throw error;
      }
    },
    clearAfterDelete: async (absolutePath, contentBefore) => {
      const relativePath = resolveMemoryRelativePath(params.mutationRoot, absolutePath);
      if (!relativePath) {
        return;
      }
      try {
        await clearMemoryArtifactProvenance({
          workspaceDir: params.workspaceDir,
          relativePath,
          contentBefore,
        });
      } catch (error) {
        // The file is already gone. Retaining stale quarantine is safer than
        // reporting the filesystem mutation as failed after it committed.
        logWarn(`memory provenance cleanup failed for ${relativePath}: ${String(error)}`);
      }
    },
  };
}
