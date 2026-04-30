import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleDirFetch } from "./dir-fetch.js";

let tmpRoot: string;

beforeEach(async () => {
  // realpath: see file-fetch.test.ts for the macOS symlinked-tmpdir reason.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-fetch-test-")));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// dir-fetch shells out to /usr/bin/tar. Skip the body of these tests on
// platforms without it (Windows CI). They still register, just no-op.
const HAS_TAR = process.platform !== "win32";

describe("handleDirFetch — input validation", () => {
  it("rejects empty / non-string path", async () => {
    expect(await handleDirFetch({ path: "" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });

  it("rejects relative paths", async () => {
    expect(await handleDirFetch({ path: "relative" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });

  it("rejects paths with NUL bytes", async () => {
    expect(await handleDirFetch({ path: "/tmp/foo\0bar" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });
});

describe("handleDirFetch — fs errors", () => {
  it.runIf(HAS_TAR)("returns NOT_FOUND for a missing directory", async () => {
    const r = await handleDirFetch({ path: path.join(tmpRoot, "missing") });
    expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it.runIf(HAS_TAR)("returns IS_FILE when path resolves to a file", async () => {
    const f = path.join(tmpRoot, "f.txt");
    await fs.writeFile(f, "x");
    expect(await handleDirFetch({ path: f })).toMatchObject({
      ok: false,
      code: "IS_FILE",
    });
  });
});

describe("handleDirFetch — happy path", () => {
  it("preflights directory entries without creating a tarball", async () => {
    await fs.writeFile(path.join(tmpRoot, "a.txt"), "alpha\n");
    await fs.mkdir(path.join(tmpRoot, ".ssh"));
    await fs.writeFile(path.join(tmpRoot, ".ssh", "id_rsa"), "secret\n");
    await fs.mkdir(path.join(tmpRoot, "sub"));
    await fs.writeFile(path.join(tmpRoot, "sub", "b.txt"), "beta\n");

    const r = await handleDirFetch({ path: tmpRoot, preflightOnly: true });
    if (!r.ok) {
      throw new Error(`expected ok, got ${r.code}: ${r.message}`);
    }

    expect(r).toMatchObject({
      path: tmpRoot,
      tarBase64: "",
      tarBytes: 0,
      sha256: "",
      preflightOnly: true,
    });
    expect(r.entries).toEqual([".ssh", ".ssh/id_rsa", "a.txt", "sub", "sub/b.txt"]);
    expect(r.fileCount).toBe(r.entries?.length);
  });

  it.runIf(HAS_TAR)("returns a gzipped tar with byte count and sha256", async () => {
    await fs.writeFile(path.join(tmpRoot, "a.txt"), "alpha\n");
    await fs.writeFile(path.join(tmpRoot, "b.txt"), "beta\n");
    await fs.mkdir(path.join(tmpRoot, "sub"));
    await fs.writeFile(path.join(tmpRoot, "sub", "c.txt"), "gamma\n");

    const r = await handleDirFetch({ path: tmpRoot });
    if (!r.ok) {
      throw new Error(`expected ok, got ${r.code}: ${r.message}`);
    }

    expect(r.tarBytes).toBeGreaterThan(0);
    expect(r.tarBase64.length).toBeGreaterThan(0);

    const buf = Buffer.from(r.tarBase64, "base64");
    expect(buf.byteLength).toBe(r.tarBytes);

    const expectedSha = crypto.createHash("sha256").update(buf).digest("hex");
    expect(r.sha256).toBe(expectedSha);

    // gzip magic bytes
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);

    // file count covers the regular files we created (3); BSD tar may also
    // list directory entries, so be generous.
    expect(r.fileCount).toBeGreaterThanOrEqual(3);
    expect(r.entries).toEqual(expect.arrayContaining(["a.txt", "b.txt", "sub", "sub/c.txt"]));
    expect(r.fileCount).toBe(r.entries?.length);
  });
});

describe("handleDirFetch — size cap", () => {
  it.runIf(HAS_TAR)(
    "returns TREE_TOO_LARGE when content exceeds the cap mid-stream",
    async () => {
      // Write enough random content to exceed a small maxBytes. Random bytes
      // don't compress, so gzip output is roughly the same size as input.
      const big = crypto.randomBytes(512 * 1024);
      await fs.writeFile(path.join(tmpRoot, "big1.bin"), big);
      await fs.writeFile(path.join(tmpRoot, "big2.bin"), big);
      await fs.writeFile(path.join(tmpRoot, "big3.bin"), big);

      // 64KB cap should trip either the du preflight or the streaming SIGTERM.
      const r = await handleDirFetch({ path: tmpRoot, maxBytes: 64 * 1024 });
      expect(r).toMatchObject({ ok: false, code: "TREE_TOO_LARGE" });
    },
    30_000,
  );
});
