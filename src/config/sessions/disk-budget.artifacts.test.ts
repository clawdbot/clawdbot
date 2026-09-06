import nodeFs from "node:fs";
import type { PathLike, StatOptions } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { saveLegacySessionStore as saveSessionStore } from "../../infra/state-migrations.legacy-session-store.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { pruneUnreferencedSessionArtifacts } from "./disk-budget.js";
import type { SessionEntry } from "./types.js";

async function expectPathExists(targetPath: string): Promise<void> {
  await fs.access(targetPath);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
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

describe("pruneUnreferencedSessionArtifacts", () => {
  it("reclaims stale store temp sidecars but preserves in-flight ones (#56827)", async () => {
    await withTestDir({ prefix: "openclaw-prune-temp-" }, async (dir) => {
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
      const old = new Date(Date.now() - 30 * 60 * 1000);
      await fs.utimes(staleTemp, old, old);

      const result = await pruneUnreferencedSessionArtifacts({
        store,
        storePath,
        olderThanMs: 30 * 24 * 60 * 60 * 1000,
      });

      await expectPathMissing(staleTemp);
      await expectPathExists(freshTemp);
      await expectPathExists(storePath);
      expect(result.removedFiles).toBeGreaterThanOrEqual(1);
    });
  });

  it("reclaims unreferenced skills prompt blobs during normal artifact cleanup", async () => {
    await withTestDir({ prefix: "openclaw-prune-prompt-blob-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const oldKey = "agent:main:old";
      const keepKey = "agent:main:keep";
      const oldPrompt = `<available_skills>\n${"old prompt\n".repeat(200)}</available_skills>`;
      const keepPrompt = `<available_skills>\n${"keep prompt\n".repeat(200)}</available_skills>`;
      const store: Record<string, SessionEntry> = {
        [oldKey]: {
          sessionId: "old",
          updatedAt: 1,
          skillsSnapshot: {
            prompt: oldPrompt,
            skills: [{ name: "old" }],
            version: 1,
          },
        },
        [keepKey]: {
          sessionId: "keep",
          updatedAt: 2,
          skillsSnapshot: {
            prompt: keepPrompt,
            skills: [{ name: "keep" }],
            version: 1,
          },
        },
      };
      await saveSessionStore(storePath, store, { skipMaintenance: true });

      const raw = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, SessionEntry>;
      const oldHash = raw[oldKey]?.skillsSnapshot?.promptRef?.hash;
      const keepHash = raw[keepKey]?.skillsSnapshot?.promptRef?.hash;
      if (!oldHash || !keepHash) {
        throw new Error("expected prompt refs");
      }
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

  it("preserves fresh unreferenced skills prompt blobs during normal artifact cleanup", async () => {
    await withTestDir({ prefix: "openclaw-prune-fresh-prompt-blob-" }, async (dir) => {
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
    await withTestDir({ prefix: "openclaw-prune-revalidate-prompt-blob-" }, async (dir) => {
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
    await withTestDir({ prefix: "openclaw-prune-prompt-temp-" }, async (dir) => {
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
