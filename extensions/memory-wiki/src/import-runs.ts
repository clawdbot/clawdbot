// Memory Wiki plugin module implements import runs behavior.
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  listMemoryWikiImportRunRecords,
  type ChatGptImportRunRecord,
} from "./import-runs-state.js";

type MemoryWikiImportRunSummary = {
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

type MemoryWikiImportRunsStatus = {
  runs: MemoryWikiImportRunSummary[];
  totalRuns: number;
  activeRuns: number;
  rolledBackRuns: number;
};

function toImportRunSummary(record: ChatGptImportRunRecord): MemoryWikiImportRunSummary {
  const createdPaths = record.createdPaths.map((entry) => entry.path);
  const updatedPaths = record.updatedPaths.map((entry) => entry.path);
  const pagePaths = uniqueStrings([...createdPaths, ...updatedPaths]);

  return {
    runId: record.runId,
    importType: record.importType,
    appliedAt: record.appliedAt,
    exportPath: record.exportPath,
    sourcePath: record.sourcePath,
    conversationCount: record.conversationCount,
    createdCount: record.createdCount,
    updatedCount: record.updatedCount,
    skippedCount: record.skippedCount,
    status: record.rolledBackAt ? "rolled_back" : "applied",
    ...(record.rolledBackAt ? { rolledBackAt: record.rolledBackAt } : {}),
    pagePaths,
    samplePaths: pagePaths.slice(0, 5),
  };
}

export async function listMemoryWikiImportRuns(
  config: ResolvedMemoryWikiConfig,
  options?: { limit?: number },
): Promise<MemoryWikiImportRunsStatus> {
  const limit = Math.max(1, Math.floor(options?.limit ?? 10));
  const runs = (await listMemoryWikiImportRunRecords(config.vault.path))
    .map(toImportRunSummary)
    .toSorted((left, right) => right.appliedAt.localeCompare(left.appliedAt));

  return {
    runs: runs.slice(0, limit),
    totalRuns: runs.length,
    activeRuns: runs.filter((entry) => entry.status === "applied").length,
    rolledBackRuns: runs.filter((entry) => entry.status === "rolled_back").length,
  };
}
