import path from "node:path";
import type { RootDefaults } from "@openclaw/fs-safe/root";
import { isMissingPathError } from "../infra/errors.js";
import { root } from "../infra/fs-safe.js";
import type { MemoryFlushPlan } from "../plugins/memory-state.js";
import { withFileMutationQueue } from "./sessions/tools/file-mutation-queue.js";

const DAILY_MEMORY_PATH_RE = /^memory\/\d{4}-\d{2}-\d{2}\.md$/u;

type MemoryFileRoot = {
  readText(relativePath: string): Promise<string>;
  write(relativePath: string, content: string, options?: { mkdir?: boolean }): Promise<void>;
};

type MemoryFileStoreDependencies = {
  openRoot: (rootDir: string, defaults: RootDefaults) => Promise<MemoryFileRoot>;
  withFileMutationQueue: <T>(filePath: string, operation: () => Promise<T>) => Promise<T>;
};

export type MemoryFileAppendResult = Readonly<{
  status: "created" | "already_present";
}>;

export type MemoryFileAppendParams = {
  workspaceDir: string;
  relativePath: string;
  entry: string;
  originClass: "agent" | "untrusted";
  observedAt: number;
  recordWriteProvenance?: MemoryFlushPlan["recordWriteProvenance"];
};

function containsExactEntry(content: string, entry: string): boolean {
  const normalizedContent = content.replaceAll("\r\n", "\n").trimEnd();
  const normalizedEntry = entry.replaceAll("\r\n", "\n").trim();
  if (!normalizedEntry) {
    return false;
  }
  return `\n${normalizedContent}\n`.includes(`\n${normalizedEntry}\n`);
}

function buildAppendedContent(contentBefore: string, entry: string): string {
  const separator = contentBefore.length > 0 && !contentBefore.endsWith("\n") ? "\n" : "";
  return `${contentBefore}${separator}${entry}\n`;
}

function createMemoryFileStore(dependencies: MemoryFileStoreDependencies) {
  return async (params: MemoryFileAppendParams): Promise<MemoryFileAppendResult> => {
    if (!DAILY_MEMORY_PATH_RE.test(params.relativePath)) {
      throw new Error("memory store path must be the canonical daily memory file");
    }
    const entry = params.entry.replaceAll("\r\n", "\n").trim();
    if (!entry) {
      throw new Error("memory text required");
    }
    const workspaceDir = path.resolve(params.workspaceDir);
    const absolutePath = path.join(workspaceDir, ...params.relativePath.split("/"));
    return await dependencies.withFileMutationQueue(absolutePath, async () => {
      const workspaceRoot = await dependencies.openRoot(workspaceDir, {
        hardlinks: "reject",
        mkdir: true,
        mode: 0o600,
        symlinks: "reject",
      });
      const contentBefore = await workspaceRoot
        .readText(params.relativePath)
        .catch((error: unknown) => {
          if (isMissingPathError(error)) {
            return "";
          }
          throw error;
        });
      if (containsExactEntry(contentBefore, entry)) {
        return { status: "already_present" };
      }

      const contentAfter = buildAppendedContent(contentBefore, entry);
      const rollback = await params.recordWriteProvenance?.({
        workspaceDir,
        relativePath: params.relativePath,
        contentBefore,
        contentAfter,
        originClass: params.originClass,
        observedAt: params.observedAt,
      });
      try {
        await workspaceRoot.write(params.relativePath, contentAfter, { mkdir: true });
        const persisted = await workspaceRoot.readText(params.relativePath);
        if (persisted !== contentAfter) {
          throw new Error("memory append could not be verified from disk");
        }
      } catch (error) {
        try {
          await rollback?.();
        } catch (rollbackError) {
          throw new Error(
            `Memory append failed and provenance rollback also failed: ${String(error)}`,
            { cause: rollbackError },
          );
        }
        throw error;
      }
      return { status: "created" };
    });
  };
}

export const appendMemoryFileEntry = createMemoryFileStore({
  openRoot: root,
  withFileMutationQueue,
});

export const memoryFileStoreTesting = {
  create: createMemoryFileStore,
};
