import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DIR_LIST_DEFAULT_MAX_ENTRIES,
  DIR_LIST_HARD_MAX_ENTRIES,
  handleDirList,
} from "./dir-list.js";

let tmpRoot: string;

beforeEach(async () => {
  // realpath: see file-fetch.test.ts for the macOS symlinked-tmpdir reason.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-list-test-")));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("handleDirList — input validation", () => {
  it("rejects empty / non-string path", async () => {
    expect(await handleDirList({ path: "" })).toMatchObject({ ok: false, code: "INVALID_PATH" });
    expect(await handleDirList({ path: undefined })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });

  it("rejects relative paths", async () => {
    expect(await handleDirList({ path: "relative" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });

  it("rejects paths with NUL bytes", async () => {
    expect(await handleDirList({ path: "/tmp/foo\0bar" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });
});

describe("handleDirList — fs errors", () => {
  it("returns NOT_FOUND for a missing directory", async () => {
    expect(await handleDirList({ path: path.join(tmpRoot, "does-not-exist") })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("returns IS_FILE when path resolves to a regular file", async () => {
    const f = path.join(tmpRoot, "f.txt");
    await fs.writeFile(f, "x");
    expect(await handleDirList({ path: f })).toMatchObject({ ok: false, code: "IS_FILE" });
  });
});

describe("handleDirList — happy path", () => {
  it("lists files and subdirs with metadata, sorted by name", async () => {
    await fs.writeFile(path.join(tmpRoot, "z.txt"), "Z");
    await fs.writeFile(path.join(tmpRoot, "a.png"), "PNG-bytes");
    await fs.mkdir(path.join(tmpRoot, "subdir"));

    const r = await handleDirList({ path: tmpRoot });
    if (!r.ok) {
      throw new Error("expected ok");
    }
    expect(r.entries.map((e) => e.name)).toEqual(["a.png", "subdir", "z.txt"]);

    const a = r.entries.find((e) => e.name === "a.png")!;
    expect(a.isDir).toBe(false);
    expect(a.size).toBeGreaterThan(0);
    expect(a.mimeType).toBe("image/png");

    const sub = r.entries.find((e) => e.name === "subdir")!;
    expect(sub.isDir).toBe(true);
    expect(sub.size).toBe(0);
    expect(sub.mimeType).toBe("inode/directory");

    expect(r.truncated).toBe(false);
    expect(r.nextPageToken).toBeUndefined();
  });

  it("includes dotfiles in the listing", async () => {
    await fs.writeFile(path.join(tmpRoot, ".hidden"), "x");
    await fs.writeFile(path.join(tmpRoot, "visible"), "x");

    const r = await handleDirList({ path: tmpRoot });
    if (!r.ok) {
      throw new Error("expected ok");
    }
    expect(r.entries.map((e) => e.name)).toEqual([".hidden", "visible"]);
  });

  it("paginates via pageToken (offset-based)", async () => {
    for (let i = 0; i < 7; i++) {
      // zero-pad so localeCompare-stable sort matches creation order
      await fs.writeFile(path.join(tmpRoot, `f-${i}.txt`), "x");
    }

    const page1 = await handleDirList({ path: tmpRoot, maxEntries: 3 });
    if (!page1.ok) {
      throw new Error("page1");
    }
    expect(page1.entries.map((e) => e.name)).toEqual(["f-0.txt", "f-1.txt", "f-2.txt"]);
    expect(page1.truncated).toBe(true);
    expect(page1.nextPageToken).toBe("3");

    const page2 = await handleDirList({
      path: tmpRoot,
      maxEntries: 3,
      pageToken: page1.nextPageToken,
    });
    if (!page2.ok) {
      throw new Error("page2");
    }
    expect(page2.entries.map((e) => e.name)).toEqual(["f-3.txt", "f-4.txt", "f-5.txt"]);
    expect(page2.truncated).toBe(true);

    const page3 = await handleDirList({
      path: tmpRoot,
      maxEntries: 3,
      pageToken: page2.nextPageToken,
    });
    if (!page3.ok) {
      throw new Error("page3");
    }
    expect(page3.entries.map((e) => e.name)).toEqual(["f-6.txt"]);
    expect(page3.truncated).toBe(false);
    expect(page3.nextPageToken).toBeUndefined();
  });
});

describe("handleDirList — limits", () => {
  it("clamps maxEntries to the hard ceiling and uses the default for invalid values", () => {
    expect(DIR_LIST_DEFAULT_MAX_ENTRIES).toBe(200);
    expect(DIR_LIST_HARD_MAX_ENTRIES).toBe(5000);
    expect(DIR_LIST_DEFAULT_MAX_ENTRIES).toBeLessThan(DIR_LIST_HARD_MAX_ENTRIES);
  });
});
