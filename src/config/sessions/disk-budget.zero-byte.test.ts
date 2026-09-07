import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  enforceSessionDiskBudget,
  measureSessionPhysicalDiskUsage,
  pruneSessionTranscriptArchivesToHighWater,
  pruneUnreferencedSessionArtifacts,
} from "./disk-budget.js";
import type { SessionEntry } from "./types.js";

const EMPTY_PROMPT_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PROMPT_FILE = `skills-prompts/sha256/e3/${EMPTY_PROMPT_HASH}.txt`;
const TEMP_SUFFIX = ".123.0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp";
const ARCHIVE_STAMP = "2026-01-01T00-00-00.000Z";
const PRESSURE = { maxDiskBytes: 64, highWaterBytes: 64 };
const EMPTY_ARTIFACTS = [
  { kind: "transcript", name: "orphan.jsonl" },
  { kind: "trajectory", name: "orphan.trajectory.jsonl" },
  { kind: "trajectory pointer", name: "orphan.trajectory-path.json" },
  { kind: "checkpoint", name: "orphan.checkpoint.0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b.jsonl" },
  { kind: "prompt blob", name: PROMPT_FILE },
  { kind: "prompt temp", name: `${PROMPT_FILE}${TEMP_SUFFIX}` },
  { kind: "store temp", name: `sessions.json${TEMP_SUFFIX}` },
];

async function writeOldFile(dir: string, name: string, content = ""): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  const old = new Date(Date.now() - 60 * 60_000);
  await fs.utimes(filePath, old, old);
  return filePath;
}

describe.each([false, true])("zero-byte artifact accounting (dryRun=%s)", (dryRun) => {
  describe.each(["unreferenced", "budget"] as const)("%s cleanup", (cleanup) => {
    it.each(EMPTY_ARTIFACTS)(
      "counts an empty $kind once without freeing bytes",
      async ({ name }) => {
        await withTestDir({ prefix: "openclaw-zero-byte-" }, async (dir) => {
          const storePath = path.join(dir, "sessions.json");
          const artifact = await writeOldFile(dir, name);
          await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));
          const removedPaths: string[] = [];
          const run = () =>
            cleanup === "unreferenced"
              ? pruneUnreferencedSessionArtifacts({
                  store: {},
                  storePath,
                  olderThanMs: 1000,
                  dryRun,
                })
              : enforceSessionDiskBudget({
                  store: {},
                  storePath,
                  maintenance: PRESSURE,
                  warnOnly: false,
                  dryRun,
                  onRemoveFile: (removedPath) => removedPaths.push(removedPath),
                });

          const result = await run();

          expect(result).toMatchObject({ removedFiles: 1, freedBytes: 0 });
          expect(nodeFs.existsSync(artifact)).toBe(dryRun);
          if (cleanup === "budget") {
            expect(result).toMatchObject({
              removedEntries: 0,
              totalBytesBefore: 130,
              totalBytesAfter: 130,
            });
            expect(removedPaths).toEqual([artifact]);
          }
          if (!dryRun) {
            expect(await run()).toMatchObject({ removedFiles: 0, freedBytes: 0 });
            expect(removedPaths).toEqual(cleanup === "budget" ? [artifact] : []);
          }
        });
      },
    );
  });

  it("counts shared empty evicted artifacts once and notifies only when applied", async () => {
    await withTestDir({ prefix: "openclaw-zero-byte-evicted-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const artifacts = await Promise.all(
        ["old.jsonl", "old.trajectory.jsonl", "old.trajectory-path.json", PROMPT_FILE].map((name) =>
          writeOldFile(dir, name),
        ),
      );
      const store: Record<string, SessionEntry> = {};
      for (const sessionId of ["old", "alias"]) {
        store[`agent:main:subagent:${sessionId}`] = {
          sessionId,
          sessionFile: path.join(dir, "old.jsonl"),
          updatedAt: 1,
          archivedAt: 1,
          archiveReason: "active-session-cap",
          skillsSnapshot: {
            prompt: "",
            skills: [],
            promptRef: { version: 1, algorithm: "sha256", hash: EMPTY_PROMPT_HASH, bytes: 0 },
          },
        };
      }
      await fs.writeFile(storePath, JSON.stringify(store, null, 2));
      await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));
      const removedPaths: string[] = [];

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: PRESSURE,
        warnOnly: false,
        dryRun,
        commitEvictedIndex: async () => {
          await fs.writeFile(storePath, JSON.stringify(store, null, 2));
        },
        onRemoveFile: (removedPath) => removedPaths.push(removedPath),
      });

      expect(result).toMatchObject({
        removedEntries: 2,
        removedFiles: artifacts.length,
        freedBytes: 0,
        totalBytesAfter: 130,
      });
      expect(store).toEqual({});
      expect(artifacts.map((artifact) => nodeFs.existsSync(artifact))).toEqual(
        artifacts.map(() => dryRun),
      );
      expect(removedPaths.toSorted()).toEqual(dryRun ? [] : artifacts.toSorted());
    });
  });
});

it("counts empty retained archives under pressure and returns real disk usage", async () => {
  await withTestDir({ prefix: "openclaw-zero-byte-archives-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const archives = await Promise.all(
      ["deleted", "reset", "bak"].map((reason) =>
        writeOldFile(dir, `old.jsonl.${reason}.${ARCHIVE_STAMP}`),
      ),
    );
    const excludedName = `keep.jsonl.deleted.${ARCHIVE_STAMP}`;
    const excluded = await writeOldFile(dir, excludedName);
    await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));
    const params = { storePath, highWaterBytes: 64, excludeNames: new Set([excludedName]) };

    const result = await pruneSessionTranscriptArchivesToHighWater(params);

    expect(result.removedFiles).toBe(3);
    expect(result.usage).toEqual(await measureSessionPhysicalDiskUsage(storePath));
    expect(result.usage.totalBytes).toBe(128);
    expect(archives.map((archive) => nodeFs.existsSync(archive))).toEqual([false, false, false]);
    expect(nodeFs.existsSync(excluded)).toBe(true);
    expect(await pruneSessionTranscriptArchivesToHighWater(params)).toEqual({
      removedFiles: 0,
      usage: result.usage,
    });
  });
});

it("does not count or notify an empty file removed by another cleanup before rm", async () => {
  await withTestDir({ prefix: "openclaw-missing-removal-" }, async (dir) => {
    const artifact = await writeOldFile(dir, "orphan.jsonl");
    await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));
    const onRemoveFile = vi.fn();
    const originalRm = nodeFs.promises.rm.bind(nodeFs.promises);
    const rm = vi.spyOn(nodeFs.promises, "rm").mockImplementation(async (target, options) => {
      if (target === artifact) {
        await originalRm(target);
      }
      return originalRm(target, options);
    });
    try {
      const result = await enforceSessionDiskBudget({
        store: {},
        storePath: path.join(dir, "sessions.json"),
        maintenance: PRESSURE,
        warnOnly: false,
        onRemoveFile,
      });

      expect(result).toMatchObject({ removedFiles: 0, freedBytes: 0 });
      expect(onRemoveFile).not.toHaveBeenCalled();
      await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      rm.mockRestore();
    }
  });
});

it.each(["unreferenced", "budget", "archives"] as const)(
  "%s cleanup does not count a rejected nonempty removal or dispatch its callback",
  async (cleanup) => {
    await withTestDir({ prefix: "openclaw-rejected-removal-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const name = cleanup === "archives" ? `old.jsonl.deleted.${ARCHIVE_STAMP}` : "orphan.jsonl";
      const content = "x".repeat(64);
      const artifact = await writeOldFile(dir, name, content);
      await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));
      const removedPaths: string[] = [];
      const originalRm = nodeFs.promises.rm.bind(nodeFs.promises);
      const rm = vi.spyOn(nodeFs.promises, "rm").mockImplementation(async (target, options) => {
        if (target === artifact) {
          throw new Error("injected removal failure");
        }
        return originalRm(target, options);
      });
      try {
        if (cleanup === "archives") {
          const result = await pruneSessionTranscriptArchivesToHighWater({
            storePath,
            highWaterBytes: 64,
          });
          expect(result.removedFiles).toBe(0);
          expect(result.usage.totalBytes).toBe(192);
        } else {
          const result =
            cleanup === "unreferenced"
              ? await pruneUnreferencedSessionArtifacts({ store: {}, storePath, olderThanMs: 1000 })
              : await enforceSessionDiskBudget({
                  store: {},
                  storePath,
                  maintenance: PRESSURE,
                  warnOnly: false,
                  onRemoveFile: (removedPath) => removedPaths.push(removedPath),
                });
          expect(result).toMatchObject({ removedFiles: 0, freedBytes: 0 });
          if (cleanup === "budget") {
            expect(result).toMatchObject({ totalBytesBefore: 194, totalBytesAfter: 194 });
          }
        }
        expect(await fs.readFile(artifact, "utf8")).toBe(content);
        expect(removedPaths).toEqual([]);
      } finally {
        rm.mockRestore();
      }
    });
  },
);
