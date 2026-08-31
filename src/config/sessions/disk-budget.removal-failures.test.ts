import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeTextAtomic } from "../../infra/json-files.js";
import { saveLegacySessionStore } from "../../infra/state-migrations.legacy-session-store.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import {
  enforceSessionDiskBudget,
  measureSessionPhysicalDiskUsage,
  pruneSessionTranscriptArchivesToHighWater,
  pruneUnreferencedSessionArtifacts,
} from "./disk-budget.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { projectSessionStoreForPersistence } from "./skill-prompt-blobs.js";
import type { SessionEntry } from "./types.js";

function rejectRemoval(targetPath: string, code: "EPERM" | "EACCES") {
  const originalRm = nodeFs.promises.rm.bind(nodeFs.promises);
  return vi.spyOn(nodeFs.promises, "rm").mockImplementation(async (target, options) => {
    if (target === targetPath) {
      throw Object.assign(new Error(`injected ${code}`), { code });
    }
    return await originalRm(target, options);
  });
}

describe("session artifact deletion failures", () => {
  it.each([
    { boundary: "archives", promptBlob: false, code: "EPERM" },
    { boundary: "unreferenced", promptBlob: false, code: "EACCES" },
    { boundary: "unreferenced", promptBlob: true, code: "EPERM" },
    { boundary: "budget", promptBlob: false, code: "EPERM" },
    { boundary: "budget", promptBlob: true, code: "EACCES" },
  ] as const)(
    "$boundary skips $code without counting failed deletions (promptBlob=$promptBlob)",
    async ({ boundary, promptBlob, code }) => {
      await withTestDir({ prefix: "openclaw-removal-failure-" }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await fs.writeFile(storePath, "{}");
        const paths: string[] = [];
        for (const [index, size] of [100, 60, 40].entries()) {
          const hash = String(index).repeat(64);
          const filePath = promptBlob
            ? path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2), `${hash}.txt`)
            : path.join(
                dir,
                boundary === "archives"
                  ? `old-${index}.jsonl.deleted.2026-01-01T00-00-00.000Z`
                  : `old-${index}.jsonl`,
              );
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, Buffer.alloc(size, index + 1));
          const staleTime = new Date(Date.now() - (30 - index) * 60_000);
          await fs.utimes(filePath, staleTime, staleTime);
          paths.push(filePath);
        }
        const [blockedPath] = paths;
        if (!blockedPath) {
          throw new Error("expected oldest artifact path");
        }
        const onRemoveFile = vi.fn();
        const rmSpy = rejectRemoval(blockedPath, code);
        try {
          if (boundary === "archives") {
            const result = await pruneSessionTranscriptArchivesToHighWater({
              storePath,
              highWaterBytes: 102,
            });
            expect.soft(result.removedFiles).toBe(2);
            expect.soft(result.usage.totalBytes).toBe(102);
          } else if (boundary === "unreferenced") {
            const result = await pruneUnreferencedSessionArtifacts({
              store: {},
              storePath,
              olderThanMs: 60_000,
            });
            expect.soft(result).toMatchObject({ removedFiles: 2, freedBytes: 100 });
          } else {
            const result = await enforceSessionDiskBudget({
              store: {},
              storePath,
              maintenance: { maxDiskBytes: 150, highWaterBytes: 102 },
              warnOnly: false,
              onRemoveFile,
            });
            expect.soft(result).toMatchObject({
              removedFiles: 2,
              removedEntries: 0,
              freedBytes: 100,
              totalBytesBefore: 202,
              totalBytesAfter: 102,
            });
            expect.soft(onRemoveFile.mock.calls).toEqual(paths.slice(1).map((file) => [file]));
          }
          expect.soft(await fs.readFile(blockedPath)).toEqual(Buffer.alloc(100, 1));
          for (const filePath of paths.slice(1)) {
            expect.soft(nodeFs.existsSync(filePath)).toBe(false);
          }
          expect.soft((await measureSessionPhysicalDiskUsage(storePath)).totalBytes).toBe(102);
        } finally {
          rmSpy.mockRestore();
        }
      });
    },
  );

  it.each([
    { artifact: "transcript", code: "EPERM", mode: "enforce" },
    { artifact: "promptBlob", code: "EACCES", mode: "enforce" },
    { artifact: "all", code: "EPERM", mode: "enforce" },
    { artifact: "transcript", code: "EPERM", mode: "dry-run" },
    { artifact: "transcript", code: "EPERM", mode: "warn" },
  ] as const)(
    "continues eviction after $artifact deletion failure ($code, $mode)",
    async ({ artifact, code, mode }) => {
      await withTestDir({ prefix: "openclaw-deferred-removal-failure-" }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        const hash = "a".repeat(64);
        const oldKey = "agent:main:subagent:old";
        const activeKey = "agent:main:active";
        const preservedKey = "agent:main:preserved";
        const laterKey = "agent:main:subagent:later";
        const retainedStore = {
          [activeKey]: { sessionId: "active", updatedAt: 1 },
          [preservedKey]: { sessionId: "preserved", updatedAt: 1 },
          [laterKey]: { sessionId: "later", updatedAt: 3 },
        } satisfies Record<string, SessionEntry>;
        const store: Record<string, SessionEntry> = {
          [oldKey]: {
            sessionId: "old",
            updatedAt: 2,
            skillsSnapshot: {
              prompt: "",
              skills: [],
              promptRef: { algorithm: "sha256", version: 1, hash, bytes: 600 },
            },
          },
          ...retainedStore,
        };
        const artifacts = [
          {
            kind: "promptBlob",
            owner: oldKey,
            file: path.join(dir, "skills-prompts", "sha256", "aa", `${hash}.txt`),
            size: 600,
          },
          { kind: "transcript", owner: oldKey, file: path.join(dir, "old.jsonl"), size: 400 },
          {
            kind: "pointer",
            owner: oldKey,
            file: path.join(dir, "old.trajectory-path.json"),
            size: 80,
          },
          {
            kind: "trajectory",
            owner: oldKey,
            file: path.join(dir, "old.trajectory.jsonl"),
            size: 120,
          },
          { kind: "later", owner: laterKey, file: path.join(dir, "later.jsonl"), size: 1000 },
        ];
        for (const { file, size } of artifacts) {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, Buffer.alloc(size, 1));
          await fs.utimes(file, new Date(0), new Date(0));
        }
        for (const entry of [retainedStore[activeKey], retainedStore[preservedKey]]) {
          await fs.writeFile(path.join(dir, `${entry.sessionId}.jsonl`), Buffer.alloc(64));
        }
        const originalStoreJson = JSON.stringify(store, null, 2);
        await fs.writeFile(storePath, originalStoreJson);
        const highWaterBytes =
          Buffer.byteLength(JSON.stringify(retainedStore, null, 2)) + 2 * 64 + 1000;
        const blocked = artifacts.filter(({ kind }) => artifact === "all" || kind === artifact);
        const onRemoveFile = vi.fn();
        const log = { warn: vi.fn(), info: vi.fn() };
        const commitEvictedIndex = vi.fn(async () => {
          await writeTextAtomic(storePath, JSON.stringify(store, null, 2), { durable: true });
        });
        const originalRm = nodeFs.promises.rm.bind(nodeFs.promises);
        const attempted: string[] = [];
        const rmSpy = vi
          .spyOn(nodeFs.promises, "rm")
          .mockImplementation(async (target, options) => {
            const candidate = artifacts.find(({ file }) => file === target);
            if (candidate) {
              const persisted = JSON.parse(await fs.readFile(storePath, "utf8"));
              expect.soft(persisted[candidate.owner]).toBeUndefined();
              expect.soft(persisted[activeKey]).toEqual(retainedStore[activeKey]);
              expect.soft(persisted[preservedKey]).toEqual(retainedStore[preservedKey]);
              attempted.push(candidate.file);
            }
            if (blocked.some(({ file }) => file === target)) {
              throw Object.assign(new Error(`injected ${code}`), { code });
            }
            return await originalRm(target, options);
          });
        try {
          const result = await enforceSessionDiskBudget({
            store,
            storePath,
            activeSessionKey: activeKey,
            preserveKeys: new Set([preservedKey]),
            maintenance: { maxDiskBytes: highWaterBytes + 1, highWaterBytes },
            warnOnly: mode === "warn",
            dryRun: mode === "dry-run",
            commitEvictedIndex,
            onRemoveFile,
            log,
          });
          if (mode !== "enforce") {
            expect(commitEvictedIndex).not.toHaveBeenCalled();
            expect(rmSpy).not.toHaveBeenCalled();
            expect(onRemoveFile).not.toHaveBeenCalled();
            expect(await fs.readFile(storePath, "utf8")).toBe(originalStoreJson);
            for (const { file, size } of artifacts) {
              expect(await fs.readFile(file)).toEqual(Buffer.alloc(size, 1));
            }
            const preview = mode === "dry-run";
            expect(store).toEqual(preview ? retainedStore : JSON.parse(originalStoreJson));
            expect(result).toMatchObject({
              removedEntries: preview ? 1 : 0,
              removedFiles: preview ? 4 : 0,
              freedBytes: preview ? 1200 : 0,
              totalBytesAfter: preview
                ? highWaterBytes
                : (await measureSessionPhysicalDiskUsage(storePath)).totalBytes,
            });
            return;
          }
          const expectedStore: Record<string, SessionEntry> = { ...retainedStore };
          delete expectedStore[laterKey];
          expect.soft(JSON.parse(await fs.readFile(storePath, "utf8"))).toEqual(expectedStore);
          expect.soft(store).toEqual(expectedStore);
          expect.soft(attempted).toEqual(artifacts.map(({ file }) => file));
          const removed = artifacts.filter((candidate) => !blocked.includes(candidate));
          for (const { file } of removed) {
            expect.soft(nodeFs.existsSync(file)).toBe(false);
          }
          for (const { file, size } of blocked) {
            expect(await fs.readFile(file)).toEqual(Buffer.alloc(size, 1));
          }
          const usage = await measureSessionPhysicalDiskUsage(storePath);
          expect.soft(result).toMatchObject({
            removedEntries: 2,
            removedFiles: removed.length,
            freedBytes: removed.reduce((sum, file) => sum + file.size, 0),
            totalBytesAfter: usage.totalBytes,
          });
          expect.soft(onRemoveFile.mock.calls).toEqual(removed.map(({ file }) => [file]));
          if (artifact === "all") {
            expect.soft(usage.totalBytes).toBeGreaterThan(highWaterBytes);
            expect
              .soft(log.warn)
              .toHaveBeenCalledWith(
                "session disk budget still above high-water target after cleanup",
                expect.objectContaining({ totalBytes: usage.totalBytes }),
              );
            expect.soft(log.info).not.toHaveBeenCalled();
          } else {
            expect.soft(usage.totalBytes).toBeLessThanOrEqual(highWaterBytes);
            expect.soft(log.warn).not.toHaveBeenCalled();
            expect
              .soft(log.info)
              .toHaveBeenCalledWith(
                "applied session disk budget cleanup",
                expect.objectContaining({ totalBytesAfter: usage.totalBytes }),
              );
          }
        } finally {
          rmSpy.mockRestore();
        }
      });
    },
  );

  it("keeps newly persisted prompt bytes counted while continuing to the next victim", async () => {
    await withTestDir({ prefix: "openclaw-budget-persisted-prompt-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const oldKey = "agent:main:subagent:old";
      const laterKey = "agent:main:subagent:later";
      const activeKey = "agent:main:main";
      const prompt = "p".repeat(600);
      const store: Record<string, SessionEntry> = {
        [oldKey]: { sessionId: "old", updatedAt: 1, delivery: { kind: "none" } },
        [laterKey]: {
          sessionId: "later",
          updatedAt: 2,
          delivery: { kind: "none" },
          skillsSnapshot: { prompt, skills: [] },
        },
        [activeKey]: { sessionId: "active", updatedAt: 3, delivery: { kind: "none" } },
      };
      const oldTranscript = path.join(dir, "old.jsonl");
      const laterTranscript = path.join(dir, "later.jsonl");
      await fs.writeFile(oldTranscript, Buffer.alloc(1000));
      await fs.writeFile(laterTranscript, Buffer.alloc(1000));
      await fs.writeFile(storePath, JSON.stringify(store, null, 2));
      const projected = projectSessionStoreForPersistence({ storePath, store });
      const blob = [...projected.promptBlobs.values()][0];
      if (!blob?.path) {
        throw new Error("expected projected prompt blob path");
      }
      const retained = { ...projected.store };
      delete retained[oldKey];
      const highWaterBytes = Buffer.byteLength(JSON.stringify(retained, null, 2)) + 1600;
      const rmSpy = rejectRemoval(oldTranscript, "EPERM");
      try {
        const result = await enforceSessionDiskBudget({
          store,
          storePath,
          maintenance: { maxDiskBytes: highWaterBytes + 1, highWaterBytes },
          warnOnly: false,
          commitEvictedIndex: () =>
            saveLegacySessionStore(storePath, store, { skipMaintenance: true }),
        });
        expect.soft(Object.keys(store)).toEqual([activeKey]);
        expect.soft(nodeFs.existsSync(laterTranscript)).toBe(false);
        expect(await fs.readFile(oldTranscript)).toEqual(Buffer.alloc(1000));
        expect(await fs.readFile(blob.path, "utf8")).toBe(prompt);
        const usage = await measureSessionPhysicalDiskUsage(storePath);
        // Legacy persistence appends a newline; the budget models the JSON payload.
        expect.soft(result).toMatchObject({
          removedEntries: 2,
          removedFiles: 1,
          freedBytes: 1000,
          totalBytesAfter: usage.totalBytes - 1,
        });
        expect.soft(usage.totalBytes).toBeLessThanOrEqual(highWaterBytes);
      } finally {
        rmSpy.mockRestore();
      }
    });
  });

  it("reports only successful orphan removals in the applied cleanup-service summary", async () => {
    await withOpenClawTestState({ label: "cleanup-removal-failure" }, async (state) => {
      const cfg = { session: { maintenance: { maxDiskBytes: false, pruneAfter: "1d" } } } as const;
      await state.writeConfig(cfg);
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main", storePath },
        { sessionId: "active", updatedAt: Date.now() },
      );
      const blocked = path.join(state.sessionsDir(), "blocked.jsonl");
      const removable = path.join(state.sessionsDir(), "removable.jsonl");
      await fs.mkdir(state.sessionsDir(), { recursive: true });
      for (const [file, size] of [
        [blocked, 100],
        [removable, 60],
      ] as const) {
        await fs.writeFile(file, Buffer.alloc(size));
        await fs.utimes(file, new Date(0), new Date(0));
      }
      const rmSpy = rejectRemoval(blocked, "EACCES");
      try {
        const result = await runSessionsCleanup({
          cfg,
          opts: { enforce: true },
          targets: [{ agentId: "main", storePath }],
        });
        expect(result.previewResults[0]?.summary.unreferencedArtifacts).toMatchObject({
          removedFiles: 2,
          freedBytes: 160,
        });
        expect(result.appliedSummaries[0]).toMatchObject({
          applied: true,
          beforeCount: 1,
          afterCount: 1,
          unreferencedArtifacts: { removedFiles: 1, freedBytes: 60 },
        });
        expect(await fs.readFile(blocked)).toEqual(Buffer.alloc(100));
        expect(nodeFs.existsSync(removable)).toBe(false);
      } finally {
        rmSpy.mockRestore();
      }
    });
  });
});
