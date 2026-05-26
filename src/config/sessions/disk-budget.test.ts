import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
} from "../../trajectory/paths.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { enforceSessionDiskBudget, pruneUnreferencedSessionArtifacts } from "./disk-budget.js";
import type { SessionEntry } from "./types.js";

async function expectPathExists(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).resolves.toBeUndefined();
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected path to be missing: ${targetPath}`);
}

function expectBudgetResult(
  result: Awaited<ReturnType<typeof enforceSessionDiskBudget>>,
): asserts result is NonNullable<Awaited<ReturnType<typeof enforceSessionDiskBudget>>> {
  if (result === null) {
    throw new Error("expected disk budget enforcement result");
  }
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
      expectBudgetResult(result);
      expect(result.removedFiles).toBe(0);
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
      expectBudgetResult(result);
      expect(result.removedFiles).toBe(1);
      expect(result.removedEntries).toBe(0);
    });
  });

  it("reclaims stale store temps under pressure but never a fresh in-flight one (#56827)", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const staleTemp = path.join(
        dir,
        "sessions.json.111.0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp",
      );
      const freshTemp = path.join(
        dir,
        "sessions.json.222.1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d.tmp",
      );
      const store: Record<string, SessionEntry> = {
        "agent:main:main": { sessionId, updatedAt: Date.now() },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(transcriptPath, "k".repeat(80), "utf-8");
      await fs.writeFile(staleTemp, "s".repeat(300), "utf-8");
      await fs.writeFile(freshTemp, "f".repeat(300), "utf-8");
      // Age the stale temp past the staleness window; the fresh one is in-flight.
      const old = new Date(Date.now() - 30 * 60 * 1000);
      await fs.utimes(staleTemp, old, old);

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 750,
          highWaterBytes: 600,
        },
        warnOnly: false,
      });

      // Stale orphan reclaimed; fresh in-flight temp (a live atomic-write source)
      // and referenced transcript preserved even though still over the high-water mark.
      await expectPathMissing(staleTemp);
      await expectPathExists(freshTemp);
      await expectPathExists(transcriptPath);
      expectBudgetResult(result);
      expect(result.removedFiles).toBe(1);
    });
  });

  it("preserves runtime-provided session keys when removing entries for disk budget", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const childKey = "agent:main:subagent:pending-budget";
      const removableKey = "agent:main:old-removable";
      const now = Date.now();
      const store: Record<string, SessionEntry> = {
        [childKey]: {
          sessionId: "pending-budget",
          updatedAt: now - 10_000,
          spawnedBy: "agent:main:main",
        },
        [removableKey]: {
          sessionId: "old-removable",
          updatedAt: now,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        preserveKeys: new Set([childKey]),
        maintenance: {
          maxDiskBytes: 120,
          highWaterBytes: 80,
        },
        warnOnly: false,
      });

      expectBudgetResult(result);
      expect(result.removedEntries).toBe(1);
      expect(store).toHaveProperty(childKey);
      expect(store).not.toHaveProperty(removableKey);
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
      const referencedPostCompactionPath = path.join(dir, "keep-compacted.jsonl");
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
              postCompaction: { sessionId, sessionFile: referencedPostCompactionPath },
            },
          ],
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(transcriptPath, "k".repeat(80), "utf-8");
      await fs.writeFile(checkpointPath, "c".repeat(5000), "utf-8");
      await fs.writeFile(referencedCheckpointPath, "r".repeat(260), "utf-8");
      await fs.writeFile(referencedPostCompactionPath, "p".repeat(260), "utf-8");

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
      await expectPathExists(referencedPostCompactionPath);
      expectBudgetResult(result);
      expect(result.removedFiles).toBe(1);
      expect(result.removedEntries).toBe(0);
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
      expectBudgetResult(result);
      expect(result.removedFiles).toBe(2);
      expect(result.removedEntries).toBe(0);
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
      expectBudgetResult(result);
      expect(result.removedEntries).toBe(1);
    });
  });
});

describe("pruneUnreferencedSessionArtifacts", () => {
  it("reclaims stale store temp sidecars but preserves in-flight ones (#56827)", async () => {
    await withTempDir({ prefix: "openclaw-prune-temp-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const staleTemp = path.join(
        dir,
        "sessions.json.111.0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp",
      );
      const freshTemp = path.join(
        dir,
        "sessions.json.222.1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d.tmp",
      );
      const store: Record<string, SessionEntry> = {
        "agent:main:main": { sessionId: "keep", updatedAt: Date.now() },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(staleTemp, "s".repeat(64), "utf-8");
      await fs.writeFile(freshTemp, "f".repeat(64), "utf-8");
      // Age the stale temp well past the temp staleness window; keep the other in-flight.
      const old = new Date(Date.now() - 30 * 60 * 1000);
      await fs.utimes(staleTemp, old, old);

      const result = await pruneUnreferencedSessionArtifacts({
        store,
        storePath,
        // 30d general cutoff: a stale temp must be reclaimed by its own short window,
        // not by the unreferenced-artifact age threshold.
        olderThanMs: 30 * 24 * 60 * 60 * 1000,
      });

      await expectPathMissing(staleTemp);
      await expectPathExists(freshTemp);
      await expectPathExists(storePath);
      expect(result.removedFiles).toBeGreaterThanOrEqual(1);
    });
  });
});
