import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
} from "../../trajectory/paths.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import type { SessionEntry } from "./types.js";

async function expectPathExists(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).resolves.toBeUndefined();
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("enforceSessionDiskBudget", () => {
  it("does not treat referenced transcripts with marker-like session IDs as archived artifacts", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep.deleted.keep";
      const activeKey = "agent:main:main";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const store: Record<string, SessionEntry> = {
        [activeKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(transcriptPath, "x".repeat(256), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: activeKey,
        maintenance: {
          maxDiskBytes: 150,
          highWaterBytes: 100,
        },
        warnOnly: false,
      });

      await expectPathExists(transcriptPath);
      expect(result).toEqual(
        expect.objectContaining({
          removedFiles: 0,
        }),
      );
    });
  });

  it("removes true archived transcript artifacts while preserving referenced primary transcripts", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const archivePath = path.join(
        dir,
        `old-session.jsonl.deleted.${formatSessionArchiveTimestamp(Date.now() - 24 * 60 * 60 * 1000)}`,
      );
      const store: Record<string, SessionEntry> = {
        "agent:main:main": {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(transcriptPath, "k".repeat(80), "utf-8");
      await fs.writeFile(archivePath, "a".repeat(260), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 300,
          highWaterBytes: 220,
        },
        warnOnly: false,
      });

      await expectPathExists(transcriptPath);
      await expectPathMissing(archivePath);
      expect(result).toEqual(
        expect.objectContaining({
          removedFiles: 1,
          removedEntries: 0,
        }),
      );
    });
  });

  it("removes unreferenced compaction checkpoint artifacts under pressure", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const checkpointPath = path.join(
        dir,
        "keep.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      );
      const referencedCheckpointPath = path.join(
        dir,
        "keep.checkpoint.22222222-2222-4222-8222-222222222222.jsonl",
      );
      const store: Record<string, SessionEntry> = {
        "agent:main:main": {
          sessionId,
          updatedAt: Date.now(),
          compactionCheckpoints: [
            {
              checkpointId: "referenced",
              sessionKey: "agent:main:main",
              sessionId,
              createdAt: Date.now(),
              reason: "manual",
              preCompaction: {
                sessionId,
                sessionFile: referencedCheckpointPath,
                leafId: "leaf",
              },
              postCompaction: { sessionId },
            },
          ],
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(transcriptPath, "k".repeat(80), "utf-8");
      await fs.writeFile(checkpointPath, "c".repeat(5000), "utf-8");
      await fs.writeFile(referencedCheckpointPath, "r".repeat(260), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 4000,
          highWaterBytes: 3000,
        },
        warnOnly: false,
      });

      await expectPathExists(transcriptPath);
      await expectPathMissing(checkpointPath);
      await expectPathExists(referencedCheckpointPath);
      expect(result).toEqual(
        expect.objectContaining({
          removedFiles: 1,
          removedEntries: 0,
        }),
      );
    });
  });

  it("removes unreferenced trajectory sidecars while preserving referenced ones", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const referencedRuntime = resolveTrajectoryFilePath({
        env: {},
        sessionFile: transcriptPath,
        sessionId,
      });
      const referencedPointer = resolveTrajectoryPointerFilePath(transcriptPath);
      const orphanRuntime = path.join(dir, "old.trajectory.jsonl");
      const orphanPointer = path.join(dir, "old.trajectory-path.json");
      const store: Record<string, SessionEntry> = {
        "agent:main:main": {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(transcriptPath, "k".repeat(80), "utf-8");
      await fs.writeFile(referencedRuntime, "r".repeat(80), "utf-8");
      await fs.writeFile(referencedPointer, "p".repeat(80), "utf-8");
      await fs.writeFile(orphanRuntime, "o".repeat(5000), "utf-8");
      await fs.writeFile(orphanPointer, "q".repeat(5000), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 7000,
          highWaterBytes: 2000,
        },
        warnOnly: false,
      });

      await expectPathExists(transcriptPath);
      await expectPathExists(referencedRuntime);
      await expectPathExists(referencedPointer);
      await expectPathMissing(orphanRuntime);
      await expectPathMissing(orphanPointer);
      expect(result).toEqual(
        expect.objectContaining({
          removedFiles: 2,
          removedEntries: 0,
        }),
      );
    });
  });

  it("does not evict protected thread session entries under store pressure", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const protectedKey = "agent:main:slack:channel:C123:thread:1710000000.000100";
      const removableKey = "agent:main:subagent:old-worker";
      const activeKey = "agent:main:main";
      const store: Record<string, SessionEntry> = {
        [protectedKey]: {
          sessionId: "protected-thread",
          updatedAt: 1,
          displayName: "p".repeat(2000),
        },
        [removableKey]: {
          sessionId: "removable-worker",
          updatedAt: 2,
          displayName: "r".repeat(2000),
        },
        [activeKey]: {
          sessionId: "active",
          updatedAt: 3,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: activeKey,
        maintenance: {
          maxDiskBytes: 1000,
          highWaterBytes: 500,
        },
        warnOnly: false,
      });

      expect(store).toHaveProperty(protectedKey);
      expect(store[removableKey]).toBeUndefined();
      expect(store).toHaveProperty(activeKey);
      expect(result).toEqual(
        expect.objectContaining({
          removedEntries: 1,
        }),
      );
    });
  });
});
