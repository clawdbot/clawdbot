// Session disk budget tests cover pruning and storage budget calculations.
import nodeFs from "node:fs";
import type { PathLike, StatOptions } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
} from "../../trajectory/paths.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { enforceSessionDiskBudget, pruneUnreferencedSessionArtifacts } from "./disk-budget.js";
import {
  replaceSqliteSessionStore,
  resolveSqliteSessionStoreDatabasePath,
} from "./store-sqlite.js";
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

function refreshPathBeforeSecondStat(targetPath: string): ReturnType<typeof vi.spyOn> {
  const originalStat = nodeFs.promises.stat.bind(nodeFs.promises);
  let statCalls = 0;
  return vi
    .spyOn(nodeFs.promises, "stat")
    .mockImplementation(async (target: PathLike, options?: StatOptions) => {
      if (target === targetPath) {
        statCalls += 1;
        if (statCalls === 2) {
          const now = new Date();
          await fs.utimes(targetPath, now, now);
        }
      }
      return await originalStat(target, options);
    });
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

  it("ignores unrelated structural SQLite database bytes outside the sessions directory", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-sqlite-" }, async (stateDir) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const sqlitePath = resolveSqliteSessionStoreDatabasePath(storePath);
      await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
      await fs.writeFile(sqlitePath, "d".repeat(1024), "utf-8");

      const result = await enforceSessionDiskBudget({
        store: {},
        storePath,
        maintenance: {
          maxDiskBytes: 512,
          highWaterBytes: 256,
        },
        warnOnly: true,
      });

      expectBudgetResult(result);
      expect(result.overBudget).toBe(false);
      expect(result.totalBytesBefore).toBe(0);
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
          maxDiskBytes: 650,
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

  it("accounts for inline SQLite skills prompts before evicting sessions", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const prompt = `<available_skills>\n${"shared prompt\n".repeat(200)}</available_skills>`;
      const now = Date.now();
      const store: Record<string, SessionEntry> = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `agent:main:${index}`,
          {
            sessionId: `session-${index}`,
            updatedAt: now + index,
            skillsSnapshot: {
              prompt,
              skills: [{ name: "demo" }],
              version: 1,
            },
          } satisfies SessionEntry,
        ]),
      );
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

      const inlineBytes = Buffer.byteLength(JSON.stringify(store, null, 2), "utf8");
      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: Math.floor(inlineBytes / 2),
          highWaterBytes: Math.floor(inlineBytes / 3),
        },
        warnOnly: false,
      });

      expectBudgetResult(result);
      expect(result.totalBytesAfter).toBeLessThanOrEqual(result.highWaterBytes);
      expect(result.removedEntries).toBeGreaterThan(0);
      expect(Object.keys(store).length).toBeLessThan(12);
    });
  });

  it("removes unreferenced skills prompt blobs when evicting sessions", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const activeKey = "agent:main:active";
      const oldKey = "agent:main:old";
      const oldHash = "a".repeat(64);
      const activeHash = "b".repeat(64);
      const store: Record<string, SessionEntry> = {
        [oldKey]: {
          sessionId: "old",
          updatedAt: 1,
          skillsSnapshot: {
            prompt: "old prompt",
            promptRef: {
              version: 1,
              algorithm: "sha256",
              hash: oldHash,
              bytes: 128,
            },
            skills: [{ name: "old" }],
            version: 1,
          },
        },
        [activeKey]: {
          sessionId: "active",
          updatedAt: 2,
          skillsSnapshot: {
            prompt: "active prompt",
            promptRef: {
              version: 1,
              algorithm: "sha256",
              hash: activeHash,
              bytes: 128,
            },
            skills: [{ name: "active" }],
            version: 1,
          },
        },
      };
      const oldBlob = path.join(
        dir,
        "skills-prompts",
        "sha256",
        oldHash.slice(0, 2),
        `${oldHash}.txt`,
      );
      const activeBlob = path.join(
        dir,
        "skills-prompts",
        "sha256",
        activeHash.slice(0, 2),
        `${activeHash}.txt`,
      );
      await fs.mkdir(path.dirname(oldBlob), { recursive: true });
      await fs.mkdir(path.dirname(activeBlob), { recursive: true });
      await fs.writeFile(oldBlob, "old prompt".repeat(80), "utf-8");
      await fs.writeFile(activeBlob, "active prompt".repeat(80), "utf-8");
      await expectPathExists(oldBlob);
      await expectPathExists(activeBlob);
      const staleBlobTime = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(oldBlob, staleBlobTime, staleBlobTime);

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: activeKey,
        maintenance: {
          maxDiskBytes: 1,
          highWaterBytes: 1,
        },
        warnOnly: false,
      });

      expectBudgetResult(result);
      expect(store).not.toHaveProperty(oldKey);
      expect(store).toHaveProperty(activeKey);
      await expectPathMissing(oldBlob);
      await expectPathExists(activeBlob);
    });
  });

  it("preserves fresh unreferenced skills prompt blobs under pressure", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-fresh-prompt-blob-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const store: Record<string, SessionEntry> = {
        "agent:main:active": { sessionId: "active", updatedAt: Date.now() },
      };
      const hash = "b".repeat(64);
      const blobDir = path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2));
      const blobPath = path.join(blobDir, `${hash}.txt`);
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.mkdir(blobDir, { recursive: true });
      await fs.writeFile(blobPath, "fresh unreferenced prompt blob".repeat(200), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: "agent:main:active",
        maintenance: {
          maxDiskBytes: 1,
          highWaterBytes: 1,
        },
        warnOnly: false,
      });

      expectBudgetResult(result);
      expect(result.overBudget).toBe(true);
      expect(result.removedFiles).toBe(0);
      await expectPathExists(blobPath);
    });
  });

  it("revalidates stale prompt blobs before removing them under pressure", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-revalidate-prompt-blob-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const store: Record<string, SessionEntry> = {
        "agent:main:active": { sessionId: "active", updatedAt: Date.now() },
      };
      const hash = "d".repeat(64);
      const blobDir = path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2));
      const blobPath = path.join(blobDir, `${hash}.txt`);
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.mkdir(blobDir, { recursive: true });
      await fs.writeFile(blobPath, "stale prompt blob".repeat(200), "utf-8");
      const staleBlobTime = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(blobPath, staleBlobTime, staleBlobTime);
      const statSpy = refreshPathBeforeSecondStat(blobPath);
      try {
        const result = await enforceSessionDiskBudget({
          store,
          storePath,
          activeSessionKey: "agent:main:active",
          maintenance: {
            maxDiskBytes: 1,
            highWaterBytes: 1,
          },
          warnOnly: false,
        });

        expectBudgetResult(result);
        expect(result.overBudget).toBe(true);
        expect(result.removedFiles).toBe(0);
        await expectPathExists(blobPath);
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  it("reclaims stale skills prompt blob temps under pressure", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-prompt-temp-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const store: Record<string, SessionEntry> = {
        "agent:main:main": { sessionId: "keep", updatedAt: Date.now() },
      };
      const hash = "a".repeat(64);
      const tempDir = path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2));
      const tempPath = path.join(
        tempDir,
        `${hash}.txt.123.11111111-1111-4111-8111-111111111111.tmp`,
      );
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(tempPath, "t".repeat(2000), "utf-8");
      const old = new Date(Date.now() - 30 * 60 * 1000);
      await fs.utimes(tempPath, old, old);

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 1000,
          highWaterBytes: 500,
        },
        warnOnly: false,
      });

      await expectPathMissing(tempPath);
      expectBudgetResult(result);
      expect(result.removedFiles).toBe(1);
      expect(result.removedEntries).toBe(0);
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

  it("reclaims unreferenced skills prompt blobs during normal artifact cleanup", async () => {
    await withTempDir({ prefix: "openclaw-prune-prompt-blob-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const oldKey = "agent:main:old";
      const keepKey = "agent:main:keep";
      const oldHash = "c".repeat(64);
      const keepHash = "d".repeat(64);
      const store: Record<string, SessionEntry> = {
        [oldKey]: {
          sessionId: "old",
          updatedAt: 1,
          skillsSnapshot: {
            prompt: "old prompt",
            promptRef: {
              version: 1,
              algorithm: "sha256",
              hash: oldHash,
              bytes: 128,
            },
            skills: [{ name: "old" }],
            version: 1,
          },
        },
        [keepKey]: {
          sessionId: "keep",
          updatedAt: 2,
          skillsSnapshot: {
            prompt: "keep prompt",
            promptRef: {
              version: 1,
              algorithm: "sha256",
              hash: keepHash,
              bytes: 128,
            },
            skills: [{ name: "keep" }],
            version: 1,
          },
        },
      };
      const oldBlob = path.join(
        dir,
        "skills-prompts",
        "sha256",
        oldHash.slice(0, 2),
        `${oldHash}.txt`,
      );
      const keepBlob = path.join(
        dir,
        "skills-prompts",
        "sha256",
        keepHash.slice(0, 2),
        `${keepHash}.txt`,
      );
      await fs.mkdir(path.dirname(oldBlob), { recursive: true });
      await fs.mkdir(path.dirname(keepBlob), { recursive: true });
      await fs.writeFile(oldBlob, "old prompt".repeat(80), "utf-8");
      await fs.writeFile(keepBlob, "keep prompt".repeat(80), "utf-8");
      await expectPathExists(oldBlob);
      await expectPathExists(keepBlob);
      const oldMtime = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(oldBlob, oldMtime, oldMtime);
      delete store[oldKey];

      const result = await pruneUnreferencedSessionArtifacts({
        store,
        storePath,
        olderThanMs: 60_000,
      });

      await expectPathMissing(oldBlob);
      await expectPathExists(keepBlob);
      expect(result.removedFiles).toBe(1);
    });
  });

  it("keeps hydrated prompt blobs while persisted SQLite rows still reference them", async () => {
    await withTempDir({ prefix: "openclaw-prune-hydrated-prompt-blob-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const keepKey = "agent:main:keep";
      const keepHash = "e".repeat(64);
      const staleHash = "f".repeat(64);
      const keepBlob = path.join(
        dir,
        "skills-prompts",
        "sha256",
        keepHash.slice(0, 2),
        `${keepHash}.txt`,
      );
      const staleBlob = path.join(
        dir,
        "skills-prompts",
        "sha256",
        staleHash.slice(0, 2),
        `${staleHash}.txt`,
      );
      await fs.mkdir(path.dirname(keepBlob), { recursive: true });
      await fs.mkdir(path.dirname(staleBlob), { recursive: true });
      await fs.writeFile(keepBlob, "keep prompt".repeat(80), "utf-8");
      await fs.writeFile(staleBlob, "stale prompt".repeat(80), "utf-8");
      const oldMtime = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(keepBlob, oldMtime, oldMtime);
      await fs.utimes(staleBlob, oldMtime, oldMtime);
      replaceSqliteSessionStore(storePath, {
        [keepKey]: {
          sessionId: "keep",
          updatedAt: 2,
          skillsSnapshot: {
            promptRef: {
              version: 1,
              algorithm: "sha256",
              hash: keepHash,
              bytes: 128,
            },
            skills: [{ name: "keep" }],
            version: 1,
          } as never,
        },
      });
      const hydratedStore: Record<string, SessionEntry> = {
        [keepKey]: {
          sessionId: "keep",
          updatedAt: 2,
          skillsSnapshot: {
            prompt: "keep prompt".repeat(80),
            skills: [{ name: "keep" }],
            version: 1,
          },
        },
      };

      const result = await pruneUnreferencedSessionArtifacts({
        store: hydratedStore,
        storePath,
        olderThanMs: 60_000,
      });

      await expectPathExists(keepBlob);
      await expectPathMissing(staleBlob);
      expect(result.removedFiles).toBe(1);
    });
  });

  it("frees hydrated prompt blobs when budget eviction removes their SQLite row", async () => {
    await withTempDir({ prefix: "openclaw-budget-hydrated-prompt-blob-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const oldKey = "agent:main:old";
      const keepKey = "agent:main:keep";
      const oldHash = "a".repeat(64);
      const keepHash = "b".repeat(64);
      const oldBlob = path.join(
        dir,
        "skills-prompts",
        "sha256",
        oldHash.slice(0, 2),
        `${oldHash}.txt`,
      );
      const keepBlob = path.join(
        dir,
        "skills-prompts",
        "sha256",
        keepHash.slice(0, 2),
        `${keepHash}.txt`,
      );
      await fs.mkdir(path.dirname(oldBlob), { recursive: true });
      await fs.mkdir(path.dirname(keepBlob), { recursive: true });
      await fs.writeFile(oldBlob, "old prompt".repeat(200), "utf-8");
      await fs.writeFile(keepBlob, "keep prompt".repeat(200), "utf-8");
      const oldMtime = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(oldBlob, oldMtime, oldMtime);
      await fs.utimes(keepBlob, oldMtime, oldMtime);
      replaceSqliteSessionStore(storePath, {
        [oldKey]: {
          sessionId: "old",
          updatedAt: 1,
          skillsSnapshot: {
            promptRef: {
              version: 1,
              algorithm: "sha256",
              hash: oldHash,
              bytes: 128,
            },
            skills: [{ name: "old" }],
            version: 1,
          } as never,
        },
        [keepKey]: {
          sessionId: "keep",
          updatedAt: 2,
          skillsSnapshot: {
            promptRef: {
              version: 1,
              algorithm: "sha256",
              hash: keepHash,
              bytes: 128,
            },
            skills: [{ name: "keep" }],
            version: 1,
          } as never,
        },
      });
      const hydratedStore: Record<string, SessionEntry> = {
        [oldKey]: {
          sessionId: "old",
          updatedAt: 1,
          skillsSnapshot: {
            prompt: "old prompt".repeat(200),
            skills: [{ name: "old" }],
            version: 1,
          },
        },
        [keepKey]: {
          sessionId: "keep",
          updatedAt: 2,
          skillsSnapshot: {
            prompt: "keep prompt".repeat(200),
            skills: [{ name: "keep" }],
            version: 1,
          },
        },
      };

      const result = await enforceSessionDiskBudget({
        store: hydratedStore,
        storePath,
        activeSessionKey: keepKey,
        maintenance: {
          maxDiskBytes: 1,
          highWaterBytes: 1,
        },
        warnOnly: false,
      });

      expectBudgetResult(result);
      expect(result.removedEntries).toBe(1);
      expect(hydratedStore).not.toHaveProperty(oldKey);
      await expectPathMissing(oldBlob);
      await expectPathExists(keepBlob);
    });
  });

  it("preserves fresh unreferenced skills prompt blobs during normal artifact cleanup", async () => {
    await withTempDir({ prefix: "openclaw-prune-fresh-prompt-blob-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const hash = "c".repeat(64);
      const blobDir = path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2));
      const blobPath = path.join(blobDir, `${hash}.txt`);
      await fs.writeFile(storePath, JSON.stringify({}, null, 2), "utf-8");
      await fs.mkdir(blobDir, { recursive: true });
      await fs.writeFile(blobPath, "fresh unreferenced prompt blob".repeat(200), "utf-8");

      const result = await pruneUnreferencedSessionArtifacts({
        store: {},
        storePath,
        olderThanMs: 0,
      });

      await expectPathExists(blobPath);
      expect(result.removedFiles).toBe(0);
    });
  });

  it("revalidates stale prompt blobs before removing them during normal artifact cleanup", async () => {
    await withTempDir({ prefix: "openclaw-prune-revalidate-prompt-blob-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const hash = "e".repeat(64);
      const blobDir = path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2));
      const blobPath = path.join(blobDir, `${hash}.txt`);
      await fs.writeFile(storePath, JSON.stringify({}, null, 2), "utf-8");
      await fs.mkdir(blobDir, { recursive: true });
      await fs.writeFile(blobPath, "stale prompt blob".repeat(200), "utf-8");
      const staleBlobTime = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(blobPath, staleBlobTime, staleBlobTime);
      const statSpy = refreshPathBeforeSecondStat(blobPath);
      try {
        const result = await pruneUnreferencedSessionArtifacts({
          store: {},
          storePath,
          olderThanMs: 60_000,
        });

        await expectPathExists(blobPath);
        expect(result.removedFiles).toBe(0);
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  it("reclaims stale skills prompt blob temps during normal artifact cleanup", async () => {
    await withTempDir({ prefix: "openclaw-prune-prompt-temp-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const store: Record<string, SessionEntry> = {
        "agent:main:main": { sessionId: "keep", updatedAt: Date.now() },
      };
      const hash = "b".repeat(64);
      const tempDir = path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2));
      const staleTemp = path.join(
        tempDir,
        `${hash}.txt.123.22222222-2222-4222-8222-222222222222.tmp`,
      );
      const freshTemp = path.join(
        tempDir,
        `${hash}.txt.456.33333333-3333-4333-8333-333333333333.tmp`,
      );
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(staleTemp, "s".repeat(64), "utf-8");
      await fs.writeFile(freshTemp, "f".repeat(64), "utf-8");
      const old = new Date(Date.now() - 30 * 60 * 1000);
      await fs.utimes(staleTemp, old, old);

      const result = await pruneUnreferencedSessionArtifacts({
        store,
        storePath,
        olderThanMs: 30 * 24 * 60 * 60 * 1000,
      });

      await expectPathMissing(staleTemp);
      await expectPathExists(freshTemp);
      expect(result.removedFiles).toBe(1);
    });
  });
});
