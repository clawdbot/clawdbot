import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleFileWrite } from "./file-write.js";

let tmpRoot: string;

beforeEach(async () => {
  // realpath: see file-fetch.test.ts for the macOS symlinked-tmpdir reason.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "file-write-test-")));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

describe("handleFileWrite — input validation", () => {
  it("rejects empty / non-string path", async () => {
    expect(await handleFileWrite({ path: "", contentBase64: b64("x") })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });

  it("rejects relative paths", async () => {
    const r = await handleFileWrite({ path: "relative.txt", contentBase64: b64("x") });
    expect(r).toMatchObject({ ok: false, code: "INVALID_PATH" });
  });

  it("rejects paths with NUL bytes", async () => {
    const r = await handleFileWrite({ path: "/tmp/foo\0bar", contentBase64: b64("x") });
    expect(r).toMatchObject({ ok: false, code: "INVALID_PATH" });
  });

  it("requires contentBase64 but allows an empty encoded payload", async () => {
    const missing = await handleFileWrite({ path: path.join(tmpRoot, "missing.bin") });
    expect(missing).toMatchObject({ ok: false, code: "INVALID_BASE64" });

    const target = path.join(tmpRoot, "empty.bin");
    const empty = await handleFileWrite({ path: target, contentBase64: "" });
    expect(empty).toMatchObject({
      ok: true,
      size: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(await fs.readFile(target)).toHaveLength(0);
  });
});

describe("handleFileWrite — happy path", () => {
  it("writes a new file and returns size + sha256 + overwritten=false", async () => {
    const target = path.join(tmpRoot, "out.txt");
    const contents = "hello write\n";
    const r = await handleFileWrite({ path: target, contentBase64: b64(contents) });
    if (!r.ok) {
      throw new Error(`expected ok, got ${r.code}: ${r.message}`);
    }
    expect(r.size).toBe(contents.length);
    expect(r.overwritten).toBe(false);
    const expectedSha = crypto.createHash("sha256").update(contents).digest("hex");
    expect(r.sha256).toBe(expectedSha);

    const onDisk = await fs.readFile(target, "utf-8");
    expect(onDisk).toBe(contents);
  });

  it("does not leave .tmp files behind on success", async () => {
    const target = path.join(tmpRoot, "atomic.txt");
    const r = await handleFileWrite({ path: target, contentBase64: b64("body") });
    expect(r.ok).toBe(true);

    const entries = await fs.readdir(tmpRoot);
    const tmpFiles = entries.filter((n) => n.includes(".tmp"));
    expect(tmpFiles).toEqual([]);
  });
});

describe("handleFileWrite — overwrite policy", () => {
  it("refuses to overwrite an existing file when overwrite=false", async () => {
    const target = path.join(tmpRoot, "exists.txt");
    await fs.writeFile(target, "before");

    const r = await handleFileWrite({
      path: target,
      contentBase64: b64("after"),
      overwrite: false,
    });
    expect(r).toMatchObject({ ok: false, code: "EXISTS_NO_OVERWRITE" });
    expect(await fs.readFile(target, "utf-8")).toBe("before");
  });

  it("overwrites and reports overwritten=true when overwrite=true", async () => {
    const target = path.join(tmpRoot, "exists.txt");
    await fs.writeFile(target, "before");

    const r = await handleFileWrite({
      path: target,
      contentBase64: b64("after"),
      overwrite: true,
    });
    if (!r.ok) {
      throw new Error("expected ok");
    }
    expect(r.overwritten).toBe(true);
    expect(await fs.readFile(target, "utf-8")).toBe("after");
  });
});

describe("handleFileWrite — parent directory handling", () => {
  it("returns PARENT_NOT_FOUND when parent is missing and createParents=false", async () => {
    const target = path.join(tmpRoot, "nested", "child.txt");
    const r = await handleFileWrite({
      path: target,
      contentBase64: b64("x"),
      createParents: false,
    });
    expect(r).toMatchObject({ ok: false, code: "PARENT_NOT_FOUND" });
  });

  it("creates missing parents when createParents=true", async () => {
    const target = path.join(tmpRoot, "deep", "nested", "child.txt");
    const r = await handleFileWrite({
      path: target,
      contentBase64: b64("x"),
      createParents: true,
    });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(target, "utf-8")).toBe("x");
  });
});

describe("handleFileWrite — symlink protection", () => {
  it("refuses to write through an existing symlink (lstat)", async () => {
    const real = path.join(tmpRoot, "real.txt");
    const link = path.join(tmpRoot, "link.txt");
    await fs.writeFile(real, "untouched");
    await fs.symlink(real, link);

    const r = await handleFileWrite({
      path: link,
      contentBase64: b64("evil"),
      overwrite: true,
    });
    expect(r).toMatchObject({ ok: false, code: "SYMLINK_TARGET_DENIED" });
    // The original file must be unchanged.
    expect(await fs.readFile(real, "utf-8")).toBe("untouched");
  });

  it("refuses to write through a symlink in a parent directory by default", async () => {
    // realDir is the actual victim; sentinel is a pre-existing file in it.
    const realDir = path.join(tmpRoot, "real-dir");
    await fs.mkdir(realDir);
    const sentinel = path.join(realDir, "sentinel.txt");
    await fs.writeFile(sentinel, "DO_NOT_TOUCH");

    // /tmpRoot/allowed -> /tmpRoot/real-dir (symlink in a parent segment).
    const allowed = path.join(tmpRoot, "allowed");
    await fs.symlink(realDir, allowed);

    // Asking to write to .../allowed/new-file.txt — the lexical parent
    // (.../allowed) resolves through a symlink to .../real-dir. Refuse.
    const r = await handleFileWrite({
      path: path.join(allowed, "new-file.txt"),
      contentBase64: b64("payload"),
    });
    expect(r).toMatchObject({ ok: false, code: "SYMLINK_REDIRECT" });
    // The error includes the canonical target so the operator can
    // either update allowWritePaths or set followSymlinks=true.
    expect(r.ok ? null : r.canonicalPath).toBe(path.join(realDir, "new-file.txt"));
    // No file was created at the canonical target.
    await expect(fs.access(path.join(realDir, "new-file.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Sentinel must be untouched.
    expect(await fs.readFile(sentinel, "utf-8")).toBe("DO_NOT_TOUCH");
  });

  it("checks symlinked parents before recursive mkdir", async () => {
    const realDir = path.join(tmpRoot, "real-dir");
    await fs.mkdir(realDir);
    const allowed = path.join(tmpRoot, "allowed");
    await fs.symlink(realDir, allowed);

    const r = await handleFileWrite({
      path: path.join(allowed, "new", "child.txt"),
      contentBase64: b64("payload"),
      createParents: true,
    });

    expect(r).toMatchObject({ ok: false, code: "SYMLINK_REDIRECT" });
    expect(r.ok ? null : r.canonicalPath).toBe(path.join(realDir, "new", "child.txt"));
    await expect(fs.access(path.join(realDir, "new"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("follows the parent symlink when followSymlinks=true", async () => {
    const realDir = path.join(tmpRoot, "real-dir");
    await fs.mkdir(realDir);
    const allowed = path.join(tmpRoot, "allowed");
    await fs.symlink(realDir, allowed);

    const r = await handleFileWrite({
      path: path.join(allowed, "new-file.txt"),
      contentBase64: b64("payload"),
      followSymlinks: true,
    });
    expect(r.ok).toBe(true);
    // The file landed in the canonical (real) directory.
    expect(await fs.readFile(path.join(realDir, "new-file.txt"), "utf-8")).toBe("payload");
  });

  it("preflights canonical write targets without creating files or parents", async () => {
    const realDir = path.join(tmpRoot, "real-dir");
    await fs.mkdir(realDir);
    const allowed = path.join(tmpRoot, "allowed");
    await fs.symlink(realDir, allowed);

    const r = await handleFileWrite({
      path: path.join(allowed, "new", "child.txt"),
      contentBase64: b64("payload"),
      createParents: true,
      followSymlinks: true,
      preflightOnly: true,
    });

    expect(r).toMatchObject({
      ok: true,
      path: path.join(realDir, "new", "child.txt"),
      size: "payload".length,
    });
    await expect(fs.access(path.join(realDir, "new"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to overwrite a directory", async () => {
    const target = path.join(tmpRoot, "is-a-dir");
    await fs.mkdir(target);

    const r = await handleFileWrite({
      path: target,
      contentBase64: b64("x"),
      overwrite: true,
    });
    expect(r).toMatchObject({ ok: false, code: "IS_DIRECTORY" });
  });
});

describe("handleFileWrite — integrity check", () => {
  it("returns INTEGRITY_FAILURE before writing when expectedSha256 mismatches", async () => {
    const target = path.join(tmpRoot, "checked.txt");
    const r = await handleFileWrite({
      path: target,
      contentBase64: b64("real-content"),
      expectedSha256: "0".repeat(64),
    });
    expect(r).toMatchObject({ ok: false, code: "INTEGRITY_FAILURE" });
    // The file must never be created on a mismatch.
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does NOT replace or delete an existing file when overwrite=true and expectedSha256 mismatches", async () => {
    const target = path.join(tmpRoot, "victim.txt");
    await fs.writeFile(target, "ORIGINAL_CONTENT_DO_NOT_TOUCH");

    const r = await handleFileWrite({
      path: target,
      contentBase64: b64("attacker-content"),
      overwrite: true,
      expectedSha256: "0".repeat(64),
    });
    expect(r).toMatchObject({ ok: false, code: "INTEGRITY_FAILURE" });
    // Critical: the original must survive. A bad caller hash must not
    // be a primitive for replacing-then-deleting an existing file.
    expect(await fs.readFile(target, "utf-8")).toBe("ORIGINAL_CONTENT_DO_NOT_TOUCH");
  });

  it("accepts a matching expectedSha256 and keeps the file", async () => {
    const target = path.join(tmpRoot, "checked.txt");
    const contents = "real-content";
    const sha = crypto.createHash("sha256").update(contents).digest("hex");

    const r = await handleFileWrite({
      path: target,
      contentBase64: b64(contents),
      expectedSha256: sha,
    });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(target, "utf-8")).toBe(contents);
  });

  it("treats expectedSha256 as case-insensitive", async () => {
    const target = path.join(tmpRoot, "checked.txt");
    const contents = "abc";
    const sha = crypto.createHash("sha256").update(contents).digest("hex").toUpperCase();

    const r = await handleFileWrite({
      path: target,
      contentBase64: b64(contents),
      expectedSha256: sha,
    });
    expect(r.ok).toBe(true);
  });
});

describe("handleFileWrite — base64 round-trip validation", () => {
  it("rejects malformed base64 that silently drops characters", async () => {
    const target = path.join(tmpRoot, "bad.bin");
    // "@" is not in the base64 alphabet — Buffer.from would silently drop
    // it and decode "AAA" instead of failing.
    const r = await handleFileWrite({
      path: target,
      contentBase64: "AAA@@@",
    });
    expect(r).toMatchObject({ ok: false, code: "INVALID_BASE64" });
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts standard base64 with and without padding", async () => {
    const target = path.join(tmpRoot, "padded.bin");
    // Buffer.from("hi") -> "aGk=" with padding, "aGk" without.
    const r1 = await handleFileWrite({ path: target, contentBase64: "aGk=" });
    expect(r1.ok).toBe(true);

    const target2 = path.join(tmpRoot, "unpadded.bin");
    const r2 = await handleFileWrite({ path: target2, contentBase64: "aGk" });
    expect(r2.ok).toBe(true);
  });

  it("accepts base64url variant (-_ instead of +/)", async () => {
    const target = path.join(tmpRoot, "url.bin");
    // Buffer.from([0xfb, 0xff]) -> "+/8=" standard, "-_8=" url
    const r = await handleFileWrite({ path: target, contentBase64: "-_8=" });
    expect(r.ok).toBe(true);
  });
});

describe("handleFileWrite — size cap", () => {
  it("rejects content larger than the 16MB cap", async () => {
    const target = path.join(tmpRoot, "big.bin");
    // 17MB of zero-bytes — base64 inflates by ~4/3 but we're checking the
    // decoded buffer length so this is fine.
    const big = Buffer.alloc(17 * 1024 * 1024, 0);
    const r = await handleFileWrite({
      path: target,
      contentBase64: big.toString("base64"),
    });
    expect(r).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
  });
});
