import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRebindableDirectoryAlias,
  withRealpathSymlinkRebindRace,
} from "../test-utils/symlink-rebind-race.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import * as pinnedPathHelperModule from "./fs-pinned-path-helper.js";
import {
  __setFsSafeTestHooksForTest,
  appendFileWithinRoot,
  copyFileWithinRoot,
  createRootScopedReadFile,
  mkdirPathWithinRoot,
  resolveOpenedFileRealPathForHandle,
  SafeOpenError,
  openFileWithinRoot,
  readFileWithinRoot,
  readPathWithinRoot,
  readLocalFileSafely,
  removePathWithinRoot,
  writeFileWithinRoot,
  writeFileFromPathWithinRoot,
} from "./fs-safe.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

async function expectWriteOpenRaceIsBlocked(params: {
  slotPath: string;
  outsideDir: string;
  runWrite: () => Promise<void>;
}): Promise<void> {
  await withRealpathSymlinkRebindRace({
    shouldFlip: (realpathInput) => realpathInput.endsWith(path.join("slot", "target.txt")),
    symlinkPath: params.slotPath,
    symlinkTarget: params.outsideDir,
    timing: "before-realpath",
    run: async () => {
      await expect(params.runWrite()).rejects.toMatchObject({
        code: expect.stringMatching(/outside-workspace|invalid-path/),
      });
    },
  });
}

async function expectSymlinkWriteRaceRejectsOutside(params: {
  slotPath: string;
  outsideDir: string;
  runWrite: (relativePath: string) => Promise<void>;
}): Promise<void> {
  const relativePath = path.join("slot", "target.txt");
  await expectWriteOpenRaceIsBlocked({
    slotPath: params.slotPath,
    outsideDir: params.outsideDir,
    runWrite: async () => await params.runWrite(relativePath),
  });
}

async function withOutsideHardlinkAlias(params: {
  aliasPath: string;
  run: (outsideFile: string) => Promise<void>;
}): Promise<void> {
  const outside = await tempDirs.make("openclaw-fs-safe-outside-");
  const outsideFile = path.join(outside, "outside.txt");
  await fs.writeFile(outsideFile, "outside");
  try {
    try {
      await fs.link(outsideFile, params.aliasPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }
    await params.run(outsideFile);
  } finally {
    await fs.rm(params.aliasPath, { force: true });
    await fs.rm(outsideFile, { force: true });
  }
}

async function setupSymlinkWriteRaceFixture(options?: { seedInsideTarget?: boolean }): Promise<{
  root: string;
  outside: string;
  slot: string;
  outsideTarget: string;
}> {
  const root = await tempDirs.make("openclaw-fs-safe-root-");
  const inside = path.join(root, "inside");
  const outside = await tempDirs.make("openclaw-fs-safe-outside-");
  await fs.mkdir(inside, { recursive: true });
  if (options?.seedInsideTarget) {
    await fs.writeFile(path.join(inside, "target.txt"), "inside");
  }
  const outsideTarget = path.join(outside, "target.txt");
  await fs.writeFile(outsideTarget, "X".repeat(4096));
  const slot = path.join(root, "slot");
  await createRebindableDirectoryAlias({
    aliasPath: slot,
    targetPath: inside,
  });
  return { root, outside, slot, outsideTarget };
}

describe("fs-safe", () => {
  it("reads a local file safely", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    const file = path.join(dir, "payload.txt");
    await fs.writeFile(file, "hello");

    const result = await readLocalFileSafely({ filePath: file });
    expect(result.buffer.toString("utf8")).toBe("hello");
    expect(result.stat.size).toBe(5);
    expect(result.realPath).toContain("payload.txt");
  });

  it("rejects directories", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    await expect(readLocalFileSafely({ filePath: dir })).rejects.toMatchObject({
      code: "not-file",
    });
    const err = await readLocalFileSafely({ filePath: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeOpenError);
    expect((err as SafeOpenError).message).not.toMatch(/EISDIR/i);
  });

  it("enforces maxBytes", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    const file = path.join(dir, "big.bin");
    await fs.writeFile(file, Buffer.alloc(8));

    await expect(readLocalFileSafely({ filePath: file, maxBytes: 4 })).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it.runIf(process.platform !== "win32")("rejects symlinks", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    const target = path.join(dir, "target.txt");
    const link = path.join(dir, "link.txt");
    await fs.writeFile(target, "target");
    await fs.symlink(target, link);

    await expect(readLocalFileSafely({ filePath: link })).rejects.toMatchObject({
      code: "symlink",
    });
  });

  it.runIf(process.platform !== "win32")(
    "resolves opened file real paths from the fd before the current path target",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const outside = await tempDirs.make("openclaw-fs-safe-outside-");
      const originalPath = path.join(root, "inside.txt");
      const movedPath = path.join(root, "inside-moved.txt");
      const outsidePath = path.join(outside, "outside.txt");
      await fs.writeFile(originalPath, "inside");
      await fs.writeFile(outsidePath, "outside");

      const handle = await fs.open(originalPath, "r");
      try {
        await fs.rename(originalPath, movedPath);
        await fs.symlink(outsidePath, originalPath);

        const resolved = await resolveOpenedFileRealPathForHandle(handle, originalPath);

        await expect(fs.realpath(movedPath)).resolves.toBe(resolved);
        await expect(handle.readFile({ encoding: "utf8" })).resolves.toBe("inside");
      } finally {
        await handle.close().catch(() => {});
      }
    },
  );

  it("blocks traversal outside root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const outside = await tempDirs.make("openclaw-fs-safe-outside-");
    const file = path.join(outside, "outside.txt");
    await fs.writeFile(file, "outside");

    await expect(
      openFileWithinRoot({
        rootDir: root,
        relativePath: path.join("..", path.basename(outside), "outside.txt"),
      }),
    ).rejects.toMatchObject({ code: "outside-workspace" });
  });

  it("rejects directory path within root without leaking EISDIR (issue #31186)", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await fs.mkdir(path.join(root, "memory"), { recursive: true });

    await expect(
      openFileWithinRoot({ rootDir: root, relativePath: "memory" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/invalid-path|not-file/) });

    const err = await openFileWithinRoot({
      rootDir: root,
      relativePath: "memory",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeOpenError);
    expect((err as SafeOpenError).message).not.toMatch(/EISDIR/i);
  });

  it("reads files within root through all read helpers", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");

    await fs.writeFile(path.join(root, "inside.txt"), "inside");
    const byRelativePath = await readFileWithinRoot({
      rootDir: root,
      relativePath: "inside.txt",
    });
    expect(byRelativePath.buffer.toString("utf8")).toBe("inside");
    expect(byRelativePath.realPath).toContain("inside.txt");
    expect(byRelativePath.stat.size).toBe(6);

    const absolutePath = path.join(root, "absolute.txt");
    await fs.writeFile(absolutePath, "absolute");
    const byAbsolutePath = await readPathWithinRoot({
      rootDir: root,
      filePath: absolutePath,
    });
    expect(byAbsolutePath.buffer.toString("utf8")).toBe("absolute");

    const scopedPath = path.join(root, "scoped.txt");
    await fs.writeFile(scopedPath, "scoped");
    const readScoped = createRootScopedReadFile({ rootDir: root });
    await expect(readScoped(scopedPath)).resolves.toEqual(Buffer.from("scoped"));
  });

  it.runIf(process.platform !== "win32")("blocks symlink escapes under root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const outside = await tempDirs.make("openclaw-fs-safe-outside-");
    const target = path.join(outside, "outside.txt");
    const link = path.join(root, "link.txt");
    await fs.writeFile(target, "outside");
    await fs.symlink(target, link);

    await expect(
      openFileWithinRoot({
        rootDir: root,
        relativePath: "link.txt",
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink-target reads when the path target changes after open",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const insideA = path.join(root, "inside-a.txt");
      const insideB = path.join(root, "inside-b.txt");
      const link = path.join(root, "link.txt");
      await fs.writeFile(insideA, "inside-a");
      await fs.writeFile(insideB, "inside-b");
      await fs.symlink(insideA, link);

      __setFsSafeTestHooksForTest({
        afterOpen: async () => {
          await fs.rm(link);
          await fs.symlink(insideB, link);
        },
      });

      await expect(
        readFileWithinRoot({
          rootDir: root,
          relativePath: "link.txt",
          allowSymlinkTargetWithinRoot: true,
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
    },
  );

  it("closes the opened handle when afterOpen hook throws", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const filePath = path.join(root, "inside.txt");
    await fs.writeFile(filePath, "inside");

    let openedHandle: FileHandle | undefined;
    __setFsSafeTestHooksForTest({
      afterOpen: (_target, handle) => {
        openedHandle = handle;
        throw new Error("after-open boom");
      },
    });

    await expect(
      openFileWithinRoot({
        rootDir: root,
        relativePath: "inside.txt",
      }),
    ).rejects.toThrow("after-open boom");
    expect(openedHandle).toBeDefined();
    await expect(openedHandle?.readFile({ encoding: "utf8" })).rejects.toMatchObject({
      code: "EBADF",
    });
  });

  it("rejects setting fs-safe test hooks outside test mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", undefined);

    expect(() =>
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: () => {},
      }),
    ).toThrow("__setFsSafeTestHooksForTest is only available in tests");
  });

  it.runIf(process.platform !== "win32")("blocks hardlink aliases under root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const hardlinkPath = path.join(root, "link.txt");
    await withOutsideHardlinkAlias({
      aliasPath: hardlinkPath,
      run: async () => {
        await expect(
          openFileWithinRoot({
            rootDir: root,
            relativePath: "link.txt",
          }),
        ).rejects.toMatchObject({ code: "invalid-path" });
      },
    });
  });

  it("writes a file within root safely", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await writeFileWithinRoot({
      rootDir: root,
      relativePath: "nested/out.txt",
      data: "hello",
    });
    await expect(fs.readFile(path.join(root, "nested", "out.txt"), "utf8")).resolves.toBe("hello");
  });

  it("appends to a file within root safely", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const targetPath = path.join(root, "nested", "out.txt");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "seed");

    await appendFileWithinRoot({
      rootDir: root,
      relativePath: "nested/out.txt",
      data: "next",
      prependNewlineIfNeeded: true,
    });

    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("seed\nnext");
  });

  it("copies a file within root safely", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const sourceDir = await tempDirs.make("openclaw-fs-safe-source-");
    const sourcePath = path.join(sourceDir, "in.txt");
    await fs.writeFile(sourcePath, "copy-ok");

    await copyFileWithinRoot({
      sourcePath,
      rootDir: root,
      relativePath: "nested/copied.txt",
    });

    await expect(fs.readFile(path.join(root, "nested", "copied.txt"), "utf8")).resolves.toBe(
      "copy-ok",
    );
  });

  it("removes a file within root safely", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const targetPath = path.join(root, "nested", "out.txt");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "hello");

    await removePathWithinRoot({
      rootDir: root,
      relativePath: "nested/out.txt",
    });

    await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates directories within root safely", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");

    await mkdirPathWithinRoot({
      rootDir: root,
      relativePath: "nested/deeper",
    });

    const stat = await fs.stat(path.join(root, "nested", "deeper"));
    expect(stat.isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "creates directories through in-root symlink parents",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const realDir = path.join(root, "real");
      const aliasDir = path.join(root, "alias");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, aliasDir);

      await mkdirPathWithinRoot({
        rootDir: root,
        relativePath: path.join("alias", "nested", "deeper"),
      });

      await expect(fs.stat(path.join(realDir, "nested", "deeper"))).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes files through in-root symlink parents",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const realDir = path.join(root, "real");
      const aliasDir = path.join(root, "alias");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, aliasDir);
      await fs.writeFile(path.join(realDir, "target.txt"), "hello");

      await removePathWithinRoot({
        rootDir: root,
        relativePath: path.join("alias", "target.txt"),
      });

      await expect(fs.stat(path.join(realDir, "target.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "falls back to legacy remove when the pinned helper cannot spawn",
    async () => {
      const error = new Error("spawn missing python ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      error.syscall = "spawn python3";
      vi.spyOn(pinnedPathHelperModule, "runPinnedPathHelper").mockRejectedValue(error);

      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const targetPath = path.join(root, "nested", "out.txt");
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, "hello");

      await removePathWithinRoot({
        rootDir: root,
        relativePath: "nested/out.txt",
      });

      await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "falls back to legacy mkdir when the pinned helper cannot spawn",
    async () => {
      const error = new Error("spawn missing python ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      error.syscall = "spawn python3";
      vi.spyOn(pinnedPathHelperModule, "runPinnedPathHelper").mockRejectedValue(error);

      const root = await tempDirs.make("openclaw-fs-safe-root-");

      await mkdirPathWithinRoot({
        rootDir: root,
        relativePath: "nested/deeper",
      });

      await expect(fs.stat(path.join(root, "nested", "deeper"))).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    },
  );

  it("enforces maxBytes when copying into root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const sourceDir = await tempDirs.make("openclaw-fs-safe-source-");
    const sourcePath = path.join(sourceDir, "big.bin");
    await fs.writeFile(sourcePath, Buffer.alloc(8));

    await expect(
      copyFileWithinRoot({
        sourcePath,
        rootDir: root,
        relativePath: "nested/big.bin",
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: "too-large" });
    await expect(fs.stat(path.join(root, "nested", "big.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes a file within root from another local source path safely", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const outside = await tempDirs.make("openclaw-fs-safe-src-");
    const sourcePath = path.join(outside, "source.bin");
    await fs.writeFile(sourcePath, "hello-from-source");
    await writeFileFromPathWithinRoot({
      rootDir: root,
      relativePath: "nested/from-source.txt",
      sourcePath,
    });
    await expect(fs.readFile(path.join(root, "nested", "from-source.txt"), "utf8")).resolves.toBe(
      "hello-from-source",
    );
  });
  it("rejects write traversal outside root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await expect(
      writeFileWithinRoot({
        rootDir: root,
        relativePath: "../escape.txt",
        data: "x",
      }),
    ).rejects.toMatchObject({ code: "outside-workspace" });
  });

  it.runIf(process.platform !== "win32")("rejects writing through hardlink aliases", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const hardlinkPath = path.join(root, "alias.txt");
    await withOutsideHardlinkAlias({
      aliasPath: hardlinkPath,
      run: async (outsideFile) => {
        await expect(
          writeFileWithinRoot({
            rootDir: root,
            relativePath: "alias.txt",
            data: "pwned",
          }),
        ).rejects.toMatchObject({ code: "invalid-path" });
        await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
      },
    });
  });

  it.runIf(process.platform !== "win32")("rejects appending through hardlink aliases", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const hardlinkPath = path.join(root, "alias.txt");
    await withOutsideHardlinkAlias({
      aliasPath: hardlinkPath,
      run: async (outsideFile) => {
        await expect(
          appendFileWithinRoot({
            rootDir: root,
            relativePath: "alias.txt",
            data: "pwned",
            prependNewlineIfNeeded: true,
          }),
        ).rejects.toMatchObject({ code: "invalid-path" });
        await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
      },
    });
  });

  it("does not truncate out-of-root file when symlink retarget races write open", async () => {
    const { root, outside, slot, outsideTarget } = await setupSymlinkWriteRaceFixture({
      seedInsideTarget: true,
    });

    await expectSymlinkWriteRaceRejectsOutside({
      slotPath: slot,
      outsideDir: outside,
      runWrite: async (relativePath) =>
        await writeFileWithinRoot({
          rootDir: root,
          relativePath,
          data: "new-content",
          mkdir: false,
        }),
    });

    await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("X".repeat(4096));
  });

  it("does not clobber out-of-root file when symlink retarget races append open", async () => {
    const { root, outside, slot, outsideTarget } = await setupSymlinkWriteRaceFixture({
      seedInsideTarget: true,
    });

    await expectSymlinkWriteRaceRejectsOutside({
      slotPath: slot,
      outsideDir: outside,
      runWrite: async (relativePath) =>
        await appendFileWithinRoot({
          rootDir: root,
          relativePath,
          data: "new-content",
          mkdir: false,
          prependNewlineIfNeeded: true,
        }),
    });

    await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("X".repeat(4096));
  });

  it.runIf(process.platform !== "win32")(
    "does not unlink out-of-root file when symlink retarget races remove",
    async () => {
      const { root, outside, slot, outsideTarget } = await setupSymlinkWriteRaceFixture({
        seedInsideTarget: true,
      });

      await withRealpathSymlinkRebindRace({
        shouldFlip: (realpathInput) => realpathInput.endsWith(path.join("slot")),
        symlinkPath: slot,
        symlinkTarget: outside,
        timing: "before-realpath",
        run: async () => {
          await expect(
            removePathWithinRoot({
              rootDir: root,
              relativePath: path.join("slot", "target.txt"),
            }),
          ).rejects.toMatchObject({
            code: expect.stringMatching(/invalid-path|not-found/),
          });
        },
      });

      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("X".repeat(4096));
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not create out-of-root directories when symlink retarget races mkdir",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const inside = path.join(root, "inside");
      const outside = await tempDirs.make("openclaw-fs-safe-outside-");
      const slot = path.join(root, "slot");
      await fs.mkdir(inside, { recursive: true });
      await createRebindableDirectoryAlias({
        aliasPath: slot,
        targetPath: inside,
      });

      await withRealpathSymlinkRebindRace({
        shouldFlip: (realpathInput) => realpathInput.endsWith(path.join("slot")),
        symlinkPath: slot,
        symlinkTarget: outside,
        timing: "before-realpath",
        run: async () => {
          await expect(
            mkdirPathWithinRoot({
              rootDir: root,
              relativePath: path.join("slot", "nested", "deep"),
            }),
          ).rejects.toMatchObject({
            code: "invalid-path",
          });
        },
      });

      await expect(fs.stat(path.join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not clobber out-of-root file when symlink retarget races write-from-path open", async () => {
    const { root, outside, slot, outsideTarget } = await setupSymlinkWriteRaceFixture();
    const sourceDir = await tempDirs.make("openclaw-fs-safe-source-");
    const sourcePath = path.join(sourceDir, "source.txt");
    await fs.writeFile(sourcePath, "new-content");

    await expectSymlinkWriteRaceRejectsOutside({
      slotPath: slot,
      outsideDir: outside,
      runWrite: async (relativePath) =>
        await writeFileFromPathWithinRoot({
          rootDir: root,
          relativePath,
          sourcePath,
          mkdir: false,
        }),
    });

    await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("X".repeat(4096));
  });

  it("returns not-found for missing files", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    const missing = path.join(dir, "missing.txt");

    await expect(readLocalFileSafely({ filePath: missing })).rejects.toBeInstanceOf(SafeOpenError);
    await expect(readLocalFileSafely({ filePath: missing })).rejects.toMatchObject({
      code: "not-found",
    });
  });
});

describe("tilde expansion in file tools", () => {
  it("keeps tilde expansion behavior aligned", async () => {
    const { expandHomePrefix } = await import("./home-dir.js");
    const originalHome = process.env.HOME;
    const originalOpenClawHome = process.env.OPENCLAW_HOME;
    const fakeHome = path.resolve(path.sep, "tmp", "fake-home-test");
    process.env.HOME = fakeHome;
    process.env.OPENCLAW_HOME = fakeHome;
    try {
      const result = expandHomePrefix("~/file.txt");
      expect(path.normalize(result)).toBe(path.join(fakeHome, "file.txt"));
    } finally {
      process.env.HOME = originalHome;
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }

    const root = await tempDirs.make("openclaw-tilde-test-");
    process.env.HOME = root;
    process.env.OPENCLAW_HOME = root;
    try {
      await fs.writeFile(path.join(root, "hello.txt"), "tilde-works");
      const result = await openFileWithinRoot({
        rootDir: root,
        relativePath: "~/hello.txt",
      });
      const buf = Buffer.alloc(result.stat.size);
      await result.handle.read(buf, 0, buf.length, 0);
      await result.handle.close();
      expect(buf.toString("utf8")).toBe("tilde-works");

      await writeFileWithinRoot({
        rootDir: root,
        relativePath: "~/output.txt",
        data: "tilde-write-works",
      });
      const content = await fs.readFile(path.join(root, "output.txt"), "utf8");
      expect(content).toBe("tilde-write-works");
    } finally {
      process.env.HOME = originalHome;
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }

    const outsideRoot = await tempDirs.make("openclaw-tilde-outside-");
    await expect(
      openFileWithinRoot({
        rootDir: outsideRoot,
        relativePath: "~/escape.txt",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/outside-workspace|not-found|invalid-path/),
    });
  });
});
