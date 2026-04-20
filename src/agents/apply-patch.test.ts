import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createRebindableDirectoryAlias,
  withRealpathSymlinkRebindRace,
} from "../test-utils/symlink-rebind-race.js";
import { applyPatch } from "./apply-patch.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

const pinnedPathHelper = vi.hoisted(() => {
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const path = require("node:path") as typeof import("node:path");
  const { pipeline } = require("node:stream/promises") as typeof import("node:stream/promises");

  async function resolvePinnedParent(params: {
    rootPath: string;
    relativeParentPath?: string;
    mkdir?: boolean;
  }): Promise<string> {
    let current = params.rootPath;
    for (const segment of (params.relativeParentPath ?? "").split("/").filter(Boolean)) {
      const next = path.join(current, segment);
      try {
        const stat = await fs.lstat(next);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error("symbolic link or non-directory path segment");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !params.mkdir) {
          throw error;
        }
        await fs.mkdir(next);
      }
      current = next;
    }
    return current;
  }

  return {
    runPinnedPathHelper: vi.fn(
      async (params: {
        operation: "mkdirp" | "remove";
        rootPath: string;
        relativePath: string;
      }) => {
        const segments = params.relativePath.split("/").filter(Boolean);
        const targetPath = path.join(params.rootPath, ...segments);
        if (params.operation === "mkdirp") {
          await resolvePinnedParent({
            rootPath: params.rootPath,
            relativeParentPath: params.relativePath,
            mkdir: true,
          });
          return;
        }
        await resolvePinnedParent({
          rootPath: params.rootPath,
          relativeParentPath: segments.slice(0, -1).join("/"),
          mkdir: false,
        });
        const stat = await fs.lstat(targetPath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          await fs.rmdir(targetPath);
          return;
        }
        await fs.unlink(targetPath);
      },
    ),
    runPinnedWriteHelper: vi.fn(
      async (params: {
        rootPath: string;
        relativeParentPath: string;
        basename: string;
        mkdir: boolean;
        mode: number;
        input:
          | { kind: "buffer"; data: string | Buffer; encoding?: BufferEncoding }
          | { kind: "stream"; stream: NodeJS.ReadableStream };
      }) => {
        const parentPath = await resolvePinnedParent({
          rootPath: params.rootPath,
          relativeParentPath: params.relativeParentPath,
          mkdir: params.mkdir,
        });
        const targetPath = path.join(parentPath, params.basename);
        if (params.input.kind === "buffer") {
          await fs.writeFile(targetPath, params.input.data, {
            encoding: params.input.encoding,
            mode: params.mode,
          });
        } else {
          const handle = await fs.open(targetPath, "w", params.mode);
          try {
            await pipeline(params.input.stream, handle.createWriteStream());
          } finally {
            await handle.close().catch(() => undefined);
          }
        }
        const stat = await fs.stat(targetPath);
        return { dev: stat.dev, ino: stat.ino };
      },
    ),
  };
});

vi.mock("../infra/fs-pinned-path-helper.js", () => ({
  isPinnedPathHelperSpawnError: () => false,
  runPinnedPathHelper: pinnedPathHelper.runPinnedPathHelper,
}));

vi.mock("../infra/fs-pinned-write-helper.js", () => ({
  runPinnedWriteHelper: pinnedPathHelper.runPinnedWriteHelper,
}));

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withWorkspaceTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(process.cwd(), "openclaw-patch-workspace-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildAddFilePatch(targetPath: string): string {
  return `*** Begin Patch
*** Add File: ${targetPath}
+escaped
*** End Patch`;
}

function createMemoryPatchSandbox(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(
    Object.entries(initialFiles).map(([filePath, contents]) => [`/sandbox/${filePath}`, contents]),
  );
  const bridge: SandboxFsBridge = {
    resolvePath: ({ filePath }) => ({
      relativePath: filePath,
      containerPath: `/sandbox/${filePath}`,
    }),
    readFile: async ({ filePath }) => Buffer.from(files.get(filePath) ?? "", "utf8"),
    writeFile: async ({ filePath, data }) => {
      files.set(filePath, Buffer.isBuffer(data) ? data.toString("utf8") : data);
    },
    remove: async ({ filePath }) => {
      files.delete(filePath);
    },
    rename: async ({ from, to }) => {
      const contents = files.get(from);
      if (contents !== undefined) {
        files.set(to, contents);
        files.delete(from);
      }
    },
    stat: async ({ filePath }) => {
      const contents = files.get(filePath);
      return contents === undefined
        ? null
        : { type: "file", size: Buffer.byteLength(contents), mtimeMs: 0 };
    },
    mkdirp: async () => {},
  };
  return {
    files,
    options: {
      cwd: "/local/workspace",
      sandbox: {
        root: "/local/workspace",
        bridge,
      },
    },
  };
}

async function expectOutsideWriteRejected(params: {
  dir: string;
  patchTargetPath: string;
  outsidePath: string;
}) {
  const patch = buildAddFilePatch(params.patchTargetPath);
  await expect(applyPatch(patch, { cwd: params.dir })).rejects.toThrow(/Path escapes sandbox root/);
  await expect(fs.readFile(params.outsidePath, "utf8")).rejects.toBeDefined();
}

describe("applyPatch", () => {
  it("adds a file", async () => {
    const memory = createMemoryPatchSandbox();
    const patch = `*** Begin Patch
*** Add File: hello.txt
+hello
*** End Patch`;

    const result = await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/hello.txt")).toBe("hello\n");
    expect(result.summary.added).toEqual(["hello.txt"]);
  });

  it("updates and moves a file", async () => {
    const memory = createMemoryPatchSandbox({
      "source.txt": "foo\nbar\n",
    });
    const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: dest.txt
@@
 foo
-bar
+baz
*** End Patch`;

    const result = await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/dest.txt")).toBe("foo\nbaz\n");
    expect(memory.files.has("/sandbox/source.txt")).toBe(false);
    expect(result.summary.modified).toEqual(["dest.txt"]);
  });

  it("supports end-of-file inserts", async () => {
    const memory = createMemoryPatchSandbox({
      "end.txt": "line1\n",
    });
    const patch = `*** Begin Patch
*** Update File: end.txt
@@
+line2
*** End of File
*** End Patch`;

    await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/end.txt")).toBe("line1\nline2\n");
  });

  it("rejects path traversal outside cwd by default", async () => {
    await withTempDir(async (dir) => {
      const escapedPath = path.join(
        path.dirname(dir),
        `escaped-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
      );
      const relativeEscape = path.relative(dir, escapedPath);

      try {
        await expectOutsideWriteRejected({
          dir,
          patchTargetPath: relativeEscape,
          outsidePath: escapedPath,
        });
      } finally {
        await fs.rm(escapedPath, { force: true });
      }
    });
  });

  it("rejects absolute paths outside cwd by default", async () => {
    await withTempDir(async (dir) => {
      const escapedPath = path.join(os.tmpdir(), `openclaw-apply-patch-${Date.now()}.txt`);

      try {
        await expectOutsideWriteRejected({
          dir,
          patchTargetPath: escapedPath,
          outsidePath: escapedPath,
        });
      } finally {
        await fs.rm(escapedPath, { force: true });
      }
    });
  });

  it("deletes the resolved target path", async () => {
    const memory = createMemoryPatchSandbox({
      "delete-me.txt": "x\n",
    });
    const patch = `*** Begin Patch
*** Delete File: delete-me.txt
*** End Patch`;

    const result = await applyPatch(patch, memory.options);

    expect(result.summary.deleted).toEqual(["delete-me.txt"]);
    expect(memory.files.has("/sandbox/delete-me.txt")).toBe(false);
  });

  it("rejects symlink escape attempts by default", async () => {
    // File symlinks require SeCreateSymbolicLinkPrivilege on Windows.
    if (process.platform === "win32") {
      return;
    }
    await withTempDir(async (dir) => {
      const outside = path.join(path.dirname(dir), "outside-target.txt");
      const linkPath = path.join(dir, "link.txt");
      await fs.writeFile(outside, "initial\n", "utf8");
      await fs.symlink(outside, linkPath);

      const patch = `*** Begin Patch
*** Update File: link.txt
@@
-initial
+pwned
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/Symlink escapes sandbox root/);
      const outsideContents = await fs.readFile(outside, "utf8");
      expect(outsideContents).toBe("initial\n");
      await fs.rm(outside, { force: true });
    });
  });

  it("rejects broken final symlink targets outside cwd by default", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withWorkspaceTempDir(async (dir) => {
      const outsideDir = path.join(path.dirname(dir), `outside-broken-link-${Date.now()}`);
      const outsideFile = path.join(outsideDir, "owned.txt");
      const linkPath = path.join(dir, "jump");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideFile, linkPath);

      const patch = `*** Begin Patch
*** Add File: jump
+pwned
*** End Patch`;

      try {
        await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
          /Symlink escapes sandbox root/,
        );
        await expect(fs.readFile(outsideFile, "utf8")).rejects.toBeDefined();
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("rejects hardlink alias escapes by default", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir(async (dir) => {
      const outside = path.join(
        path.dirname(dir),
        `outside-hardlink-${process.pid}-${Date.now()}.txt`,
      );
      const linkPath = path.join(dir, "hardlink.txt");
      await fs.writeFile(outside, "initial\n", "utf8");
      try {
        try {
          await fs.link(outside, linkPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") {
            return;
          }
          throw err;
        }
        const patch = `*** Begin Patch
*** Update File: hardlink.txt
@@
-initial
+pwned
*** End Patch`;
        await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/hardlink|sandbox/i);
        const outsideContents = await fs.readFile(outside, "utf8");
        expect(outsideContents).toBe("initial\n");
      } finally {
        await fs.rm(linkPath, { force: true });
        await fs.rm(outside, { force: true });
      }
    });
  });

  it("rejects symlinks within cwd by default", async () => {
    // File symlinks require SeCreateSymbolicLinkPrivilege on Windows.
    if (process.platform === "win32") {
      return;
    }
    await withTempDir(async (dir) => {
      const target = path.join(dir, "target.txt");
      const linkPath = path.join(dir, "link.txt");
      await fs.writeFile(target, "initial\n", "utf8");
      await fs.symlink(target, linkPath);

      const patch = `*** Begin Patch
*** Update File: link.txt
@@
-initial
+updated
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
        /path is not a regular file under root|symlink open blocked/i,
      );
      const contents = await fs.readFile(target, "utf8");
      expect(contents).toBe("initial\n");
    });
  });

  it("rejects delete path traversal via symlink directories by default", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = path.join(path.dirname(dir), `outside-dir-${process.pid}-${Date.now()}`);
      const outsideFile = path.join(outsideDir, "victim.txt");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "victim\n", "utf8");

      const linkDir = path.join(dir, "linkdir");
      // Use 'junction' on Windows — junctions target directories without
      // requiring SeCreateSymbolicLinkPrivilege.
      await fs.symlink(outsideDir, linkDir, process.platform === "win32" ? "junction" : undefined);

      const patch = `*** Begin Patch
*** Delete File: linkdir/victim.txt
*** End Patch`;

      try {
        await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
          /Symlink escapes sandbox root/,
        );
        const stillThere = await fs.readFile(outsideFile, "utf8");
        expect(stillThere).toBe("victim\n");
      } finally {
        await fs.rm(outsideFile, { force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("allows path traversal when workspaceOnly is explicitly disabled", async () => {
    await withTempDir(async (dir) => {
      const escapedPath = path.join(
        path.dirname(dir),
        `escaped-allow-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
      );
      const relativeEscape = path.relative(dir, escapedPath);

      const patch = `*** Begin Patch
*** Add File: ${relativeEscape}
+escaped
*** End Patch`;

      try {
        const result = await applyPatch(patch, { cwd: dir, workspaceOnly: false });
        expect(result.summary.added.length).toBe(1);
        const contents = await fs.readFile(escapedPath, "utf8");
        expect(contents).toBe("escaped\n");
      } finally {
        await fs.rm(escapedPath, { force: true });
      }
    });
  });

  it("allows deleting a symlink itself even if it points outside cwd", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = await fs.mkdtemp(path.join(path.dirname(dir), "openclaw-patch-outside-"));
      try {
        const outsideTarget = path.join(outsideDir, "target.txt");
        await fs.writeFile(outsideTarget, "keep\n", "utf8");

        const linkDir = path.join(dir, "link");
        // Use 'junction' on Windows — junctions target directories without
        // requiring SeCreateSymbolicLinkPrivilege.
        await fs.symlink(
          outsideDir,
          linkDir,
          process.platform === "win32" ? "junction" : undefined,
        );

        const patch = `*** Begin Patch
*** Delete File: link
*** End Patch`;

        const result = await applyPatch(patch, { cwd: dir });
        expect(result.summary.deleted).toEqual(["link"]);
        await expect(fs.lstat(linkDir)).rejects.toBeDefined();
        const outsideContents = await fs.readFile(outsideTarget, "utf8");
        expect(outsideContents).toBe("keep\n");
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not delete out-of-root files when a checked directory is rebound before remove",
    async () => {
      await withTempDir(async (dir) => {
        const inside = path.join(dir, "inside");
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-outside-"));
        const slot = path.join(dir, "slot");
        await fs.mkdir(inside, { recursive: true });
        await fs.writeFile(path.join(inside, "target.txt"), "inside\n", "utf8");
        const outsideTarget = path.join(outside, "target.txt");
        await fs.writeFile(outsideTarget, "outside\n", "utf8");
        await createRebindableDirectoryAlias({
          aliasPath: slot,
          targetPath: inside,
        });

        const patch = `*** Begin Patch
*** Delete File: slot/target.txt
*** End Patch`;

        try {
          await withRealpathSymlinkRebindRace({
            shouldFlip: (realpathInput) => realpathInput.endsWith(path.join("slot")),
            symlinkPath: slot,
            symlinkTarget: outside,
            timing: "before-realpath",
            run: async () => {
              await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
                /symlink escapes sandbox root|under root|not found/i,
              );
            },
          });
          await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside\n");
        } finally {
          await fs.rm(outside, { recursive: true, force: true });
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not create out-of-root directories when a checked directory is rebound before mkdir",
    async () => {
      await withTempDir(async (dir) => {
        const inside = path.join(dir, "inside");
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-outside-"));
        const slot = path.join(dir, "slot");
        await fs.mkdir(inside, { recursive: true });
        await createRebindableDirectoryAlias({
          aliasPath: slot,
          targetPath: inside,
        });

        const patch = `*** Begin Patch
*** Add File: slot/nested/deep/file.txt
+safe
*** End Patch`;

        try {
          await withRealpathSymlinkRebindRace({
            shouldFlip: (realpathInput) =>
              realpathInput.endsWith(path.join("slot", "nested", "deep", "file.txt")),
            symlinkPath: slot,
            symlinkTarget: outside,
            timing: "before-realpath",
            run: async () => {
              await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/under root/i);
            },
          });
          await expect(fs.stat(path.join(outside, "nested"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } finally {
          await fs.rm(outside, { recursive: true, force: true });
        }
      });
    },
  );

  it("uses container paths when the sandbox bridge has no local host path", async () => {
    const files = new Map<string, string>([["/sandbox/source.txt", "before\n"]]);
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        relativePath: filePath,
        containerPath: `/sandbox/${filePath}`,
      }),
      readFile: vi.fn(async ({ filePath }: { filePath: string }) =>
        Buffer.from(files.get(filePath) ?? "", "utf8"),
      ),
      writeFile: vi.fn(async ({ filePath, data }: { filePath: string; data: Buffer | string }) => {
        files.set(filePath, Buffer.isBuffer(data) ? data.toString("utf8") : data);
      }),
      remove: vi.fn(async ({ filePath }: { filePath: string }) => {
        files.delete(filePath);
      }),
      mkdirp: vi.fn(async () => {}),
    };

    const patch = `*** Begin Patch
*** Update File: source.txt
@@
-before
+after
*** End Patch`;

    const result = await applyPatch(patch, {
      cwd: "/local/workspace",
      sandbox: {
        root: "/local/workspace",
        bridge: bridge as never,
      },
    });

    expect(files.get("/sandbox/source.txt")).toBe("after\n");
    expect(result.summary.modified).toEqual(["source.txt"]);
    expect(bridge.readFile).toHaveBeenCalledWith({
      filePath: "/sandbox/source.txt",
      cwd: "/local/workspace",
    });
  });
});
