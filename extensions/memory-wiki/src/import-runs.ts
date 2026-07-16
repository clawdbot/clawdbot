import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedMemoryWikiConfig } from "./config.js";

export type MemoryWikiImportRunSummary = {
  runId: string;
  importType: string;
  appliedAt: string;
  exportPath: string;
  sourcePath: string;
  conversationCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  status: "applied" | "rolled_back";
  rolledBackAt?: string;
  pagePaths: string[];
  samplePaths: string[];
};

export type MemoryWikiImportRunsStatus = {
  runs: MemoryWikiImportRunSummary[];
  totalRuns: number;
  activeRuns: number;
  rolledBackRuns: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function normalizeImportRunSummary(raw: unknown): MemoryWikiImportRunSummary | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const runId = typeof record?.runId === "string" ? record.runId.trim() : "";
  const importType = typeof record?.importType === "string" ? record.importType.trim() : "";
  const appliedAt = typeof record?.appliedAt === "string" ? record.appliedAt.trim() : "";
  const exportPath = typeof record?.exportPath === "string" ? record.exportPath.trim() : "";
  const sourcePath = typeof record?.sourcePath === "string" ? record.sourcePath.trim() : "";
  if (!runId || !importType || !appliedAt || !exportPath || !sourcePath) {
    return null;
  }

  const createdPaths = asStringArray(record.createdPaths);
  const updatedPaths = Array.isArray(record.updatedPaths)
    ? record.updatedPaths
        .map((entry) => asRecord(entry))
        .map((entry) => (typeof entry?.path === "string" ? entry.path.trim() : ""))
        .filter((entry): entry is string => entry.length > 0)
    : [];
  const pagePaths = [...new Set([...createdPaths, ...updatedPaths])];
  const conversationCount =
    typeof record.conversationCount === "number" && Number.isFinite(record.conversationCount)
      ? Math.max(0, Math.floor(record.conversationCount))
      : createdPaths.length + updatedPaths.length;
  const createdCount =
    typeof record.createdCount === "number" && Number.isFinite(record.createdCount)
      ? Math.max(0, Math.floor(record.createdCount))
      : createdPaths.length;
  const updatedCount =
    typeof record.updatedCount === "number" && Number.isFinite(record.updatedCount)
      ? Math.max(0, Math.floor(record.updatedCount))
      : updatedPaths.length;
  const skippedCount =
    typeof record.skippedCount === "number" && Number.isFinite(record.skippedCount)
      ? Math.max(0, Math.floor(record.skippedCount))
      : Math.max(0, conversationCount - createdCount - updatedCount);
  const rolledBackAt =
    typeof record.rolledBackAt === "string" && record.rolledBackAt.trim().length > 0
      ? record.rolledBackAt.trim()
      : undefined;

  return {
    runId,
    importType,
    appliedAt,
    exportPath,
    sourcePath,
    conversationCount,
    createdCount,
    updatedCount,
    skippedCount,
    status: rolledBackAt ? "rolled_back" : "applied",
    ...(rolledBackAt ? { rolledBackAt } : {}),
    pagePaths,
    samplePaths: pagePaths.slice(0, 5),
  };
}

function resolveImportRunsDir(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "import-runs");
}

export async function listMemoryWikiImportRuns(
  config: ResolvedMemoryWikiConfig,
  options?: { limit?: number },
): Promise<MemoryWikiImportRunsStatus> {
  const limit = Math.max(1, Math.floor(options?.limit ?? 10));
  const importRunsDir = resolveImportRunsDir(config.vault.path);
  const entries = await fs
    .readdir(importRunsDir, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    });
  const runs = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const raw = await fs.readFile(path.join(importRunsDir, entry.name), "utf8");
          return normalizeImportRunSummary(JSON.parse(raw) as unknown);
        }),
    )
  )
    .filter((entry): entry is MemoryWikiImportRunSummary => entry !== null)
    .toSorted((left, right) => right.appliedAt.localeCompare(left.appliedAt));

  return {
    runs: runs.slice(0, limit),
    totalRuns: runs.length,
    activeRuns: runs.filter((entry) => entry.status === "applied").length,
    rolledBackRuns: runs.filter((entry) => entry.status === "rolled_back").length,
  };
}
