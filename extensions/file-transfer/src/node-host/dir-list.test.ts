// File Transfer tests cover dir list plugin behavior.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCanonicalDirListCommand } from "./dir-list-worker-command.js";
import { handleDirList } from "./dir-list.js";

let tmpRoot: string;

beforeEach(async () => {
  // realpath: see file-fetch.test.ts for the macOS symlinked-tmpdir reason.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-list-test-")));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function expectDirListError(
  input: Parameters<typeof handleDirList>[0],
  code: "INVALID_PATH" | "IS_FILE" | "NOT_FOUND",
) {
  const result = await handleDirList(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
  }
}

describe("handleDirList — input validation", () => {
  it("rejects empty / non-string path", async () => {
    await expectDirListError({ path: "" }, "INVALID_PATH");
    await expectDirListError({ path: undefined }, "INVALID_PATH");
  });

  it("rejects relative paths", async () => {
    await expectDirListError({ path: "relative" }, "INVALID_PATH");
  });

  it("rejects paths with NUL bytes", async () => {
    await expectDirListError({ path: "/tmp/foo\0bar" }, "INVALID_PATH");
  });
});

describe("handleDirList — fs errors", () => {
  it("returns NOT_FOUND for a missing directory", async () => {
    await expectDirListError({ path: path.join(tmpRoot, "does-not-exist") }, "NOT_FOUND");
  });

  it("returns IS_FILE when path resolves to a regular file", async () => {
    const f = path.join(tmpRoot, "f.txt");
    await fs.writeFile(f, "x");
    await expectDirListError({ path: f }, "IS_FILE");
  });
});

describe("handleDirList — happy path", () => {
  it.runIf(process.platform === "linux")(
    "keeps enumeration bound after the checked path is retargeted",
    async () => {
      const approved = path.join(tmpRoot, "approved");
      const replacement = path.join(tmpRoot, "replacement");
      const current = path.join(tmpRoot, "current");
      await fs.mkdir(approved);
      await fs.mkdir(replacement);
      await fs.writeFile(path.join(approved, "approved.txt"), "approved");
      await fs.writeFile(path.join(replacement, "secret.txt"), "secret");
      await fs.symlink(approved, current);
      const approvedStats = await fs.stat(approved, { bigint: true });

      const command = createCanonicalDirListCommand({
        directoryPath: current,
        expectedCanonicalPath: approved,
        expectedDevice: String(approvedStats.dev),
        expectedInode: String(approvedStats.ino),
        maxEntries: 10,
        offset: 0,
      });
      // Retarget after the real chdir, before the unchanged worker checks and
      // enumerates its bound directory. Polling /proc can miss the entire child.
      const retargetAfterBinding = `(() => {
        const fs = require("node:fs");
        const chdir = process.chdir;
        process.chdir = (directory) => {
          chdir(directory);
          process.chdir = chdir;
          fs.unlinkSync(${JSON.stringify(current)});
          fs.symlinkSync(${JSON.stringify(replacement)}, ${JSON.stringify(current)});
        };
      })();`;
      const child = spawn(
        command[0]!,
        [command[1]!, retargetAfterBinding + command[2]!, ...command.slice(3)],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      try {
        expect(await exit, Buffer.concat(stderr).toString("utf8")).toBe(0);
        expect(await fs.readlink(current)).toBe(replacement);
        const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
          entries: Array<{ name: string }>;
        };
        expect(result.entries.some((entry) => entry.name === "approved.txt")).toBe(true);
        expect(result.entries.some((entry) => entry.name === "secret.txt")).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await exit.catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a replacement created at the same canonical pathname before binding",
    async () => {
      const approved = path.join(tmpRoot, "approved");
      const moved = path.join(tmpRoot, "moved");
      await fs.mkdir(approved);
      await fs.writeFile(path.join(approved, "approved.txt"), "approved");
      const approvedStats = await fs.stat(approved, { bigint: true });
      await fs.rename(approved, moved);
      await fs.mkdir(approved);
      await fs.writeFile(path.join(approved, "secret.txt"), "secret");

      const command = createCanonicalDirListCommand({
        directoryPath: approved,
        expectedCanonicalPath: approved,
        expectedDevice: String(approvedStats.dev),
        expectedInode: String(approvedStats.ino),
        maxEntries: 10,
        offset: 0,
      });
      const child = spawn(command[0]!, command.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });

      expect(exit).toBe(78);
      expect(Buffer.concat(stdout)).toHaveLength(0);
    },
  );

  it("binds the canonical target before listing entries", async () => {
    await fs.writeFile(path.join(tmpRoot, "private.txt"), "secret");

    const preflight = await handleDirList({ path: tmpRoot, preflightOnly: true });
    expect(preflight).toMatchObject({
      ok: true,
      path: tmpRoot,
      entries: [],
      truncated: false,
      preflight: true,
    });

    const changed = await handleDirList({
      path: tmpRoot,
      expectedCanonicalPath: path.join(tmpRoot, "other"),
    });
    expect(changed).toEqual({
      ok: false,
      code: "CANONICAL_PATH_CHANGED",
      message: "canonical path differs from the authorized target",
      canonicalPath: tmpRoot,
    });
  });

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

  it("does not coerce partial page tokens", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tmpRoot, `f-${i}.txt`), "x");
    }

    const r = await handleDirList({ path: tmpRoot, maxEntries: 1, pageToken: "1next" });
    if (!r.ok) {
      throw new Error("expected ok");
    }
    expect(r.entries.map((e) => e.name)).toEqual(["f-0.txt"]);
    expect(r.nextPageToken).toBe("1");
  });

  it("accepts plus-signed page tokens", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tmpRoot, `f-${i}.txt`), "x");
    }

    const r = await handleDirList({ path: tmpRoot, maxEntries: 1, pageToken: "+01" });
    if (!r.ok) {
      throw new Error("expected ok");
    }
    expect(r.entries.map((e) => e.name)).toEqual(["f-1.txt"]);
    expect(r.nextPageToken).toBe("2");
  });

  it("uses the 200-entry default for invalid limits", async () => {
    await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        fs.writeFile(path.join(tmpRoot, `entry-${String(index).padStart(3, "0")}`), ""),
      ),
    );

    for (const maxEntries of [undefined, -1, Number.NaN, "200"] as unknown[]) {
      const result = await handleDirList({ path: tmpRoot, maxEntries });
      if (!result.ok) {
        throw new Error(`expected ok, got ${result.code}`);
      }
      expect(result.entries).toHaveLength(200);
      expect(result.nextPageToken).toBe("200");
      expect(result.truncated).toBe(true);
    }
  });
});
