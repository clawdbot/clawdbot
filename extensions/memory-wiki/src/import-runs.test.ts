// Memory Wiki tests cover import run listing behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { writeMemoryWikiImportRunRecord } from "./import-runs-state.js";
import { listMemoryWikiImportRuns } from "./import-runs.js";

const tempDirs: string[] = [];

async function makeTempVault(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-import-runs-"));
  tempDirs.push(dir);
  return dir;
}

describe("memory-wiki import runs", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("lists import runs from plugin state", async () => {
    const vaultRoot = await makeTempVault();
    const config = resolveMemoryWikiConfig({ vault: { path: vaultRoot } });
    await writeMemoryWikiImportRunRecord(vaultRoot, {
      version: 1,
      runId: "chatgpt-old",
      importType: "chatgpt",
      exportPath: "/tmp/old",
      sourcePath: "/tmp/old/conversations.json",
      appliedAt: "2026-04-09T10:00:00.000Z",
      conversationCount: 1,
      createdCount: 1,
      updatedCount: 0,
      skippedCount: 0,
      createdPaths: [{ path: "sources/old.md" }],
      updatedPaths: [],
      rolledBackAt: "2026-04-09T11:00:00.000Z",
    });
    await writeMemoryWikiImportRunRecord(vaultRoot, {
      version: 1,
      runId: "chatgpt-new",
      importType: "chatgpt",
      exportPath: "/tmp/new",
      sourcePath: "/tmp/new/conversations.json",
      appliedAt: "2026-04-10T10:00:00.000Z",
      conversationCount: 2,
      createdCount: 1,
      updatedCount: 1,
      skippedCount: 0,
      createdPaths: [{ path: "sources/new.md" }],
      updatedPaths: [{ path: "sources/current.md", snapshotPath: "snapshots/current.md" }],
    });
    await writeMemoryWikiImportRunRecord(vaultRoot, {
      version: 1,
      runId: "chatgpt-rolling",
      importType: "chatgpt",
      exportPath: "/tmp/rolling",
      sourcePath: "/tmp/rolling/conversations.json",
      appliedAt: "2026-04-11T10:00:00.000Z",
      conversationCount: 1,
      createdCount: 1,
      updatedCount: 0,
      skippedCount: 0,
      createdPaths: [{ path: "sources/rolling.md" }],
      updatedPaths: [],
      rollbackStartedAt: "2026-04-11T10:01:00.000Z",
      rollbackTargetsFinalizedAt: "2026-04-11T10:02:00.000Z",
    });

    await expect(listMemoryWikiImportRuns(config, { limit: 3 })).resolves.toEqual({
      runs: [
        {
          runId: "chatgpt-rolling",
          importType: "chatgpt",
          appliedAt: "2026-04-11T10:00:00.000Z",
          exportPath: "/tmp/rolling",
          sourcePath: "/tmp/rolling/conversations.json",
          conversationCount: 1,
          createdCount: 1,
          updatedCount: 0,
          skippedCount: 0,
          status: "rolling_back",
          rollbackStartedAt: "2026-04-11T10:01:00.000Z",
          rollbackTargetsFinalizedAt: "2026-04-11T10:02:00.000Z",
          pagePaths: ["sources/rolling.md"],
          samplePaths: ["sources/rolling.md"],
        },
        {
          runId: "chatgpt-new",
          importType: "chatgpt",
          appliedAt: "2026-04-10T10:00:00.000Z",
          exportPath: "/tmp/new",
          sourcePath: "/tmp/new/conversations.json",
          conversationCount: 2,
          createdCount: 1,
          updatedCount: 1,
          skippedCount: 0,
          status: "applied",
          pagePaths: ["sources/new.md", "sources/current.md"],
          samplePaths: ["sources/new.md", "sources/current.md"],
        },
        {
          runId: "chatgpt-old",
          importType: "chatgpt",
          appliedAt: "2026-04-09T10:00:00.000Z",
          exportPath: "/tmp/old",
          sourcePath: "/tmp/old/conversations.json",
          conversationCount: 1,
          createdCount: 1,
          updatedCount: 0,
          skippedCount: 0,
          status: "rolled_back",
          rolledBackAt: "2026-04-09T11:00:00.000Z",
          pagePaths: ["sources/old.md"],
          samplePaths: ["sources/old.md"],
        },
      ],
      totalRuns: 3,
      activeRuns: 2,
      rolledBackRuns: 1,
    });
  });
});
