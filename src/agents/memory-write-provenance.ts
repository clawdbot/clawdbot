import path from "node:path";
import { isMissingPathError } from "../infra/errors.js";
import { canonicalPathFromExistingAncestor } from "../infra/fs-safe.js";
import { logWarn } from "../logger.js";
import {
  clearMemoryArtifactProvenance,
  normalizeMemoryArtifactRelativePath,
  recordMemoryArtifactWriteProvenance,
} from "../memory/memory-artifact-provenance.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";

export type MemoryWriteProvenanceObserver = {
  classifies: (absolutePath: string) => Promise<boolean>;
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
      // Retained provenance callbacks keep the invocation's original owner.
      const assertCurrent = captureAgentToolSourceExecutionGuard();
      const commit = () => {
        assertCurrent();
        return operations.writeFile(absolutePath, content);
      };
      if (!(await observer.classifies(absolutePath))) {
        await commit();
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
        commit,
      });
    },
    ...(remove
      ? {
          remove: async (absolutePath: string) => {
            const assertCurrent = captureAgentToolSourceExecutionGuard();
            const contentBefore = (await observer.classifies(absolutePath))
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
            assertCurrent();
            await remove(absolutePath);
            await observer.clearAfterDelete(absolutePath, contentBefore);
          },
        }
      : {}),
  } as T;
}

function resolveMemoryRelativePath(root: string, absolutePath: string): string | undefined {
  const relativePath = path.relative(root, absolutePath);
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
  resolvePath?: (filePath: string) => Promise<string>;
  resolveOriginClass: () => "agent" | "untrusted";
  sessionId?: string;
  sessionKey?: string;
  now?: () => number;
}): MemoryWriteProvenanceObserver {
  const now = params.now ?? Date.now;
  const resolvePath = params.resolvePath ?? canonicalPathFromExistingAncestor;
  const resolveRelativePath = async (absolutePath: string) => {
    // Both paths must be canonicalized by the same filesystem owner: container
    // paths are not host paths, and aliases must retain memory quarantine.
    const [root, target] = await Promise.all([
      resolvePath(params.mutationRoot),
      resolvePath(absolutePath),
    ]);
    return resolveMemoryRelativePath(root, target);
  };
  return {
    classifies: async (absolutePath) => (await resolveRelativePath(absolutePath)) !== undefined,
    write: async ({ absolutePath, contentBefore, contentAfter, commit }) => {
      const relativePath = await resolveRelativePath(absolutePath);
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
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
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
      const relativePath = await resolveRelativePath(absolutePath);
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
