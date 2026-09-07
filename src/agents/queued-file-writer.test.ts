// Verifies queued file writes keep append logs bounded and symlink-safe.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getQueuedFileWriter } from "./queued-file-writer.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("getQueuedFileWriter", () => {
  it("creates log files with restrictive permissions", async () => {
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write("line\n");
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("line\n");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("refuses to append through a symlink", async () => {
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const targetPath = path.join(tmpDir, "target.txt");
    const filePath = path.join(tmpDir, "trace.jsonl");
    fs.writeFileSync(targetPath, "before\n", "utf8");
    fs.symlinkSync(targetPath, filePath);
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write("after\n");
    await writer.flush();

    expect(fs.readFileSync(targetPath, "utf8")).toBe("before\n");
  });

  it("refuses to append through a symlinked parent directory", async () => {
    // Parent directory symlinks are as dangerous as leaf-file symlinks.
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const targetDir = path.join(tmpDir, "target");
    const linkDir = path.join(tmpDir, "link");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir);
    const writer = getQueuedFileWriter(new Map(), path.join(linkDir, "trace.jsonl"));

    writer.write("after\n");
    await writer.flush();

    expect(fs.existsSync(path.join(targetDir, "trace.jsonl"))).toBe(false);
  });

  it("stops appending when the configured file cap is reached", async () => {
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath, { maxFileBytes: 6 });

    writer.write("12345\n");
    writer.write("after\n");
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("12345\n");
  });

  it("drops writes that would exceed the pending queue cap", async () => {
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath, { maxQueuedBytes: 6 });

    expect(writer.write("12345\n")).toBe("queued");
    expect(writer.write("after\n")).toBe("dropped");
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("12345\n");
  });

  it("reports pending queue diagnostics before flush drains writes", async () => {
    const tmpDir = tempDirs.make("openclaw-queued-writer-");
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath, {
      maxFileBytes: 1024,
      maxQueuedBytes: 1024,
      yieldBeforeWrite: true,
    });

    writer.write("line\n");

    expect(writer.describeQueue?.()).toEqual({
      pendingWrites: 1,
      queuedBytes: 5,
      activeOperation: "idle",
      activeWriteBytes: undefined,
      maxFileBytes: 1024,
      maxQueuedBytes: 1024,
      yieldBeforeWrite: true,
    });

    await writer.flush();

    expect(writer.describeQueue?.()).toMatchObject({
      pendingWrites: 0,
      queuedBytes: 0,
      activeOperation: "idle",
    });
  });
});
