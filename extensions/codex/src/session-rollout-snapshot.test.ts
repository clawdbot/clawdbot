import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "./app-server/test-support.js";
import { readCodexRolloutSnapshot } from "./session-rollout-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const meta = (id = "source", provider = "native-a") => ({
  type: "session_meta",
  payload: { id, model_provider: provider, dynamic_tools: [] },
});
const encode = (records: unknown[]) =>
  Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
async function fixture(records: unknown[], compressed = false) {
  const tempDir = await fs.realpath(tempDirs.make("codex-snapshot-"));
  const dir = path.join(tempDir, "sessions");
  await fs.mkdir(dir);
  const rolloutPath = path.join(dir, "rollout.jsonl");
  const selectedPath = compressed ? `${rolloutPath}.zst` : rolloutPath;
  const write = (bytes: Buffer) =>
    fs.writeFile(selectedPath, compressed ? zstdCompressSync(bytes) : bytes);
  await write(encode(records));
  return {
    dir,
    rolloutPath,
    selectedPath,
    write,
    read: () =>
      readCodexRolloutSnapshot({
        sessionsRoot: dir,
        rolloutPath,
        threadId: "source",
        assertCurrent: () => {},
      }),
  };
}

describe("bounded native rollout snapshot", () => {
  it.each([false, true])(
    "reads immutable metadata without interpreting historical records (compressed=%s)",
    async (compressed) => {
      const f = await fixture([meta()], compressed);
      // The native owner interprets history; snapshot validation needs only the header.
      await f.write(Buffer.concat([encode([meta()]), Buffer.alloc(9 * 1024 * 1024, 120)]));
      const before = await fs.readFile(f.selectedPath);
      const snapshot = await f.read();
      expect(snapshot.metadata).toEqual(meta().payload);
      await snapshot.assertUnchanged();
      // Deep equality expands every byte into entries; compare the full buffers natively.
      expect((await fs.readFile(f.selectedPath)).equals(before)).toBe(true);
    },
  );

  it("prefers the exact plain file and rejects later replacement or growth", async () => {
    const f = await fixture([meta("source", "plain")]);
    await fs.writeFile(
      `${f.rolloutPath}.zst`,
      zstdCompressSync(encode([meta("source", "compressed")])),
    );
    const snapshot = await f.read();
    expect(snapshot.metadata.model_provider).toBe("plain");
    await fs.appendFile(f.rolloutPath, encode([{ type: "event_msg", payload: {} }]));
    await expect(snapshot.assertUnchanged()).rejects.toThrow(/changed/);
    const current = await f.read();
    await fs.rename(f.rolloutPath, `${f.rolloutPath}.old`);
    await fs.copyFile(`${f.rolloutPath}.old`, f.rolloutPath);
    await expect(current.assertUnchanged()).rejects.toThrow(/changed/);
  });

  it("rejects a newly materialized plain file after selecting compressed metadata", async () => {
    const f = await fixture([meta()], true);
    const snapshot = await f.read();
    await fs.writeFile(f.rolloutPath, encode([meta()]));
    await expect(snapshot.assertUnchanged()).rejects.toThrow(/changed/);
  });

  it.each(["replacement", "symlink"])("rejects root %s after observation", async (fault) => {
    const f = await fixture([meta()]);
    const snapshot = await f.read();
    await fs.rename(f.dir, `${f.dir}.old`);
    if (fault === "symlink") {
      await fs.symlink(`${f.dir}.old`, f.dir);
    } else {
      await fs.mkdir(f.dir);
      await fs.copyFile(path.join(`${f.dir}.old`, "rollout.jsonl"), f.rolloutPath);
    }
    await expect(snapshot.assertUnchanged()).rejects.toThrow();
  });

  it("rejects a changed timestamp even when content size and inode remain unchanged", async () => {
    const f = await fixture([meta()]);
    const snapshot = await f.read();
    const before = await fs.stat(f.rolloutPath);
    await fs.utimes(f.rolloutPath, before.atime, new Date(before.mtimeMs + 1_000));
    await expect(snapshot.assertUnchanged()).rejects.toThrow(/changed/);
  });

  it.each([
    "wrong identity",
    "incomplete header",
    "oversized header",
    "malformed header",
    "hardlink",
    "symlink",
    "root symlink",
    "outside root",
  ])("fails closed for %s without selecting a fallback", async (fault) => {
    const f = await fixture([meta()]);
    await fs.writeFile(
      `${f.rolloutPath}.zst`,
      zstdCompressSync(encode([meta("source", "fallback")])),
    );
    if (fault === "wrong identity") {
      await f.write(encode([meta("wrong")]));
    }
    if (fault === "incomplete header") {
      await f.write(Buffer.from('{"type":'));
    }
    if (fault === "oversized header") {
      await f.write(encode([meta("source", "x".repeat(1024 * 1024))]));
    }
    if (fault === "malformed header") {
      await f.write(Buffer.from("{bad}\n"));
    }
    if (fault === "hardlink") {
      await fs.link(f.rolloutPath, `${f.rolloutPath}.link`);
    }
    if (fault === "symlink") {
      await fs.rename(f.rolloutPath, `${f.rolloutPath}.real`);
      await fs.symlink(`${f.rolloutPath}.real`, f.rolloutPath);
    }
    if (fault === "root symlink") {
      await fs.rename(f.dir, `${f.dir}.real`);
      await fs.symlink(`${f.dir}.real`, f.dir);
    }
    const read =
      fault === "outside root"
        ? () =>
            readCodexRolloutSnapshot({
              sessionsRoot: path.join(f.dir, "child"),
              rolloutPath: f.rolloutPath,
              threadId: "source",
              assertCurrent: () => {},
            })
        : f.read;
    if (fault === "outside root") {
      await fs.mkdir(path.join(f.dir, "child"));
    }
    await expect(read()).rejects.toThrow();
  });

  it.each([false, true])(
    "rejects invalid header UTF-8 without contaminating the next read (compressed=%s)",
    async (compressed) => {
      const invalid = await fixture([meta()], compressed);
      await invalid.write(Buffer.from([0xff, 10]));
      await expect(invalid.read()).rejects.toThrow();
      const valid = await fixture([meta()], compressed);
      await expect(valid.read()).resolves.toMatchObject({ metadata: meta().payload });
    },
  );

  it.each(["input limit", "header limit", "invalid frame"])(
    "rejects compressed %s",
    async (fault) => {
      const f = await fixture([meta()], true);
      if (fault === "input limit") {
        await fs.appendFile(f.selectedPath, Buffer.alloc(8 * 1024 * 1024));
      } else if (fault === "header limit") {
        await f.write(encode([meta("source", "x".repeat(1024 * 1024))]));
      } else {
        await fs.writeFile(f.selectedPath, "not a zstd frame");
      }
      await expect(f.read()).rejects.toThrow();
    },
  );
});
