import path from "node:path";
import type { MemoryFlushPlan } from "../plugins/memory-state.js";

export type MemoryWriteProvenanceObserver = {
  recordBeforeWrite: (params: {
    absolutePath: string;
    contentBefore: string;
    contentAfter: string;
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
    recordBeforeWrite: async ({ absolutePath, contentBefore, contentAfter }) => {
      const relativePath = resolveMemoryRelativePath(params.mutationRoot, absolutePath);
      if (!relativePath) {
        return;
      }
      await params.plan.recordWriteProvenance?.({
        workspaceDir: params.workspaceDir,
        relativePath,
        contentBefore,
        contentAfter,
        originClass: params.resolveOriginClass(),
        observedAt: now(),
      });
    },
    clearAfterDelete: async (absolutePath) => {
      const relativePath = resolveMemoryRelativePath(params.mutationRoot, absolutePath);
      if (!relativePath) {
        return;
      }
      await params.plan.clearWriteProvenance?.({
        workspaceDir: params.workspaceDir,
        relativePath,
      });
    },
  };
}
