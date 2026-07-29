import path from "node:path";
import { logWarn } from "../logger.js";
import type { MemoryFlushPlan } from "../plugins/memory-state.js";

export type MemoryWriteProvenanceObserver = {
  write: (params: {
    absolutePath: string;
    contentBefore: string;
    contentAfter: string;
    commit: () => Promise<void>;
  }) => Promise<void>;
  clearAfterDelete: (absolutePath: string) => Promise<void>;
};

function resolveMemoryRelativePath(root: string, absolutePath: string): string | undefined {
  const relativePath = path.relative(path.resolve(root), path.resolve(absolutePath));
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return undefined;
  }
  const normalized = relativePath.replaceAll(path.sep, "/");
  if (["MEMORY.md", "memory.md", "USER.md"].includes(normalized)) {
    return normalized;
  }
  return normalized.startsWith("memory/") && normalized.endsWith(".md") ? normalized : undefined;
}

export function createMemoryWriteProvenanceObserver(params: {
  mutationRoot: string;
  workspaceDir: string;
  plan: Pick<MemoryFlushPlan, "recordWriteProvenance" | "clearWriteProvenance">;
  resolveOriginClass: () => "agent" | "untrusted";
  now?: () => number;
}): MemoryWriteProvenanceObserver | undefined {
  if (!params.plan.recordWriteProvenance) {
    return undefined;
  }
  const now = params.now ?? Date.now;
  return {
    write: async ({ absolutePath, contentBefore, contentAfter, commit }) => {
      const relativePath = resolveMemoryRelativePath(params.mutationRoot, absolutePath);
      if (!relativePath) {
        await commit();
        return;
      }
      const rollback = await params.plan.recordWriteProvenance?.({
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
          throw new AggregateError(
            [error, rollbackError],
            "File write and memory provenance rollback failed",
          );
        }
        throw error;
      }
    },
    clearAfterDelete: async (absolutePath) => {
      const relativePath = resolveMemoryRelativePath(params.mutationRoot, absolutePath);
      if (!relativePath) {
        return;
      }
      try {
        await params.plan.clearWriteProvenance?.({
          workspaceDir: params.workspaceDir,
          relativePath,
        });
      } catch (error) {
        // The file is already gone. Retaining stale quarantine is safer than
        // reporting the filesystem mutation as failed after it committed.
        logWarn(`memory provenance cleanup failed for ${relativePath}: ${String(error)}`);
      }
    },
  };
}
