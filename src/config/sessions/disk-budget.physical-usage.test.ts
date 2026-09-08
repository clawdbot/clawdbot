import { channel } from "node:diagnostics_channel";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";

const workers: Worker[] = [];
const workerChannel = channel("worker_threads");
const trackWorker = (message: unknown) => workers.push((message as { worker: Worker }).worker);

beforeEach(() => workerChannel.subscribe(trackWorker));
afterEach(async () => {
  workerChannel.unsubscribe(trackWorker);
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

async function addSessionArtifacts(directory: string, index: number): Promise<void> {
  const hash = index.toString(16).padStart(64, "0");
  const blobDirectory = path.join(directory, "skills-prompts", "sha256", hash.slice(0, 2));
  await fs.mkdir(blobDirectory, { recursive: true });
  await fs.writeFile(path.join(directory, `session-${index}.jsonl`), Buffer.alloc(7));
  await fs.writeFile(path.join(blobDirectory, `${hash}.txt`), Buffer.alloc(11));
}

describe("physical session disk usage", () => {
  it("propagates worker transport failure and measures successfully after recovery", async () => {
    await withTestDir({ prefix: "openclaw-disk-usage-worker-error-" }, async (directory) => {
      const storePath = path.join(directory, "openclaw-agent.sqlite");
      await fs.writeFile(storePath, Buffer.alloc(321));
      const send = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => {
        throw new Error("synthetic worker transport failure");
      });
      try {
        await expect(measureSessionPhysicalDiskUsage(storePath)).rejects.toMatchObject({
          code: "unavailable",
          message: expect.stringContaining("synthetic worker transport failure"),
        });
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBe(-1);
      } finally {
        send.mockRestore();
      }
      await expect(measureSessionPhysicalDiskUsage(storePath)).resolves.toEqual({
        databaseMainBytes: 321,
        databaseWalBytes: 0,
        sessionFilesBytes: 0,
        totalBytes: 321,
      });
      expect(workers).toHaveLength(2);
    });
  });

  it("propagates an unreadable custom-store inventory instead of reporting zero bytes", async () => {
    await withTestDir({ prefix: "openclaw-disk-usage-error-" }, async (directory) => {
      const notDirectory = path.join(directory, "not-a-directory");
      await fs.writeFile(notDirectory, "existing file");
      await expect(
        measureSessionPhysicalDiskUsage(path.join(notDirectory, "custom-store.json")),
      ).rejects.toMatchObject({
        code: "failed",
        message: expect.stringContaining("ENOTDIR"),
      });
    });
  });

  it("does not add synchronous realpath work as session artifacts grow", async () => {
    await withTestDir({ prefix: "openclaw-disk-scan-scaling-" }, async (directory) => {
      const storePath = path.join(directory, "openclaw-agent.sqlite");
      await fs.writeFile(storePath, Buffer.alloc(321));
      await fs.writeFile(`${storePath}-wal`, Buffer.alloc(654));
      await addSessionArtifacts(directory, 0);
      const realpath = vi.spyOn(nodeFs, "realpathSync");
      const fixtureSyncCalls = () =>
        realpath.mock.calls.filter(
          ([candidate]) =>
            typeof candidate === "string" && candidate.startsWith(`${directory}${path.sep}`),
        ).length;
      try {
        const initial = await measureSessionPhysicalDiskUsage(storePath);
        const initialSyncCalls = fixtureSyncCalls();
        expect(initial).toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 18,
          totalBytes: 993,
        });
        for (let index = 1; index <= 32; index += 1) {
          await addSessionArtifacts(directory, index);
        }
        realpath.mockClear();

        const expanded = await measureSessionPhysicalDiskUsage(storePath);
        const expandedSyncCalls = fixtureSyncCalls();

        expect(expanded).toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 33 * 18,
          totalBytes: 975 + 33 * 18,
        });
        // Filesystem work that grows with the directory must not block the event loop.
        expect(expandedSyncCalls).toBeLessThanOrEqual(initialSyncCalls);
      } finally {
        realpath.mockRestore();
      }
    });
  });

  it.skipIf(process.platform === "win32")(
    "deduplicates SQLite aliases already counted through the sessions directory",
    async () => {
      await withTestDir({ prefix: "openclaw-disk-scan-alias-" }, async (directory) => {
        const sessionsDirectory = path.join(directory, "sessions-data");
        const aliasDirectory = path.join(directory, "sessions-alias");
        await fs.mkdir(sessionsDirectory);
        await fs.symlink(sessionsDirectory, aliasDirectory);
        const database = path.join(sessionsDirectory, "database.bin");
        const wal = path.join(sessionsDirectory, "wal.bin");
        await fs.writeFile(database, Buffer.alloc(321));
        await fs.writeFile(wal, Buffer.alloc(654));
        await fs.writeFile(path.join(sessionsDirectory, "active.jsonl"), Buffer.alloc(17));
        await fs.symlink(database, path.join(sessionsDirectory, "openclaw-agent.sqlite"));
        await fs.symlink(wal, path.join(sessionsDirectory, "openclaw-agent.sqlite-wal"));

        await addSessionArtifacts(sessionsDirectory, 0);
        await fs.writeFile(path.join(sessionsDirectory, "old.jsonl.migrated"), Buffer.alloc(4_096));

        const usage = await measureSessionPhysicalDiskUsage(
          path.join(aliasDirectory, "openclaw-agent.sqlite"),
        );

        expect(usage).toEqual({
          databaseMainBytes: 321,
          databaseWalBytes: 654,
          sessionFilesBytes: 35,
          totalBytes: 1_010,
        });
      });
    },
  );
});
