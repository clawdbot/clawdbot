import crypto from "node:crypto";
// File Transfer tests cover archive-policy child-output failures.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: () => void };
  stdout: EventEmitter;
};

function mockTarSpawn(script: (child: MockChild) => void) {
  return vi.fn(() => {
    const child = new EventEmitter() as MockChild;
    child.kill = vi.fn();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter() as MockChild["stdin"];
    child.stdout = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => script(child));
    return child;
  });
}

async function importWithSpawn(spawnMock: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return { ...actual, spawn: spawnMock };
  });
  return await import("./node-invoke-policy.js");
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("dir.fetch archive policy output lifecycle", () => {
  it("fails archive listing closed on stdout errors", async () => {
    const spawnMock = mockTarSpawn((child) => {
      child.stdout.emit("data", Buffer.from("partial.txt\n"));
      child.stdout.emit("error", new Error("policy listing read failed"));
      child.emit("close", 0);
    });
    const { testing } = await importWithSpawn(spawnMock);

    await expect(
      testing.listDirFetchArchiveEntries({
        tarBase64: Buffer.from("archive").toString("base64"),
      }),
    ).resolves.toEqual({
      ok: false,
      code: "ARCHIVE_ENTRIES_UNREADABLE",
      reason: "tar -tzf stdout error: Error: policy listing read failed",
    });
    expect(spawnMock.mock.results[0]?.value.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("keeps complete archive entries authoritative after diagnostic stderr errors", async () => {
    const spawnMock = mockTarSpawn((child) => {
      child.stderr.emit("error", new Error("diagnostics unavailable"));
      child.stdout.emit("data", Buffer.from("./ok.txt\n"));
      child.emit("close", 0);
    });
    const { testing } = await importWithSpawn(spawnMock);

    const archive = Buffer.from("archive");
    await expect(
      testing.listDirFetchArchiveEntries({
        tarBase64: archive.toString("base64"),
      }),
    ).resolves.toEqual({
      ok: true,
      entries: ["ok.txt"],
      sizeBytes: archive.byteLength,
      sha256: crypto.createHash("sha256").update(archive).digest("hex"),
    });
  });

  it("surfaces UTF-16 safe tar stderr tail when archive listing fails with emoji at projection boundary", async () => {
    const oldNoise = "n".repeat(250);
    // Length 201: raw slice(-200) would start on the low surrogate of 🤖.
    const recent = "🤖" + "f".repeat(199);
    const spawnMock = mockTarSpawn((child) => {
      child.stderr.emit("data", Buffer.from(oldNoise));
      child.stderr.emit("data", Buffer.from(recent));
      child.emit("close", 2);
    });
    const { testing } = await importWithSpawn(spawnMock);
    const { projectBoundedTextTail } = await import("./append-bounded-text-tail.js");

    const result = await testing.listDirFetchArchiveEntries({
      tarBase64: Buffer.from("archive").toString("base64"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(projectBoundedTextTail(recent, 200));
      expect(result.reason).toContain("f".repeat(199));
      expect(result.reason).not.toContain("🤖");
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          result.reason,
        ),
      ).toBe(false);
    }
  });
});
