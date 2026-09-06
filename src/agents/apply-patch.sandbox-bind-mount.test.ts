/**
 * Regression tests for apply_patch on explicitly bind-mounted sandbox paths.
 *
 * Before the fix for https://github.com/openclaw/openclaw/issues/93140,
 * apply_patch would run a second `assertSandboxPath` check against `options.cwd`
 * after the bridge had already resolved a bind-mount path to its host location.
 * This caused any bind-mount target whose host path lay outside the workspace
 * root to be rejected with "Path escapes sandbox root", even though the operator
 * had explicitly configured the mount and the bridge's own `SandboxFsPathGuard`
 * had accepted it.
 *
 * The fix removes the redundant post-bridge `assertSandboxPath` call in the
 * sandbox branch of `resolvePatchPath`. The bridge is the authoritative boundary
 * in sandbox mode.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch } from "./apply-patch.test-support.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

/**
 * Creates a minimal SandboxFsBridge that resolves all paths to a given host
 * directory, simulating a single writable bind mount at `containerRoot`.
 * `hostRoot` lives outside the workspace root on purpose.
 */
/**
 * Creates a minimal SandboxFsBridge that maps a container root to a host directory.
 *
 * IMPORTANT: The production bridge passes *already-resolved absolute host paths*
 * to readFile/writeFile/etc (these come from the `resolved` field of `resolvePath`).
 * Our stub must therefore accept both container-absolute paths (mapped via
 * containerRoot→hostRoot) AND already-resolved host-absolute paths (passed
 * through unchanged). The double-path bug in an earlier version of this helper
 * came from unconditionally prepending hostRoot even when the path was already
 * an absolute host path.
 */
function createBindMountBridge(params: {
  hostRoot: string;
  containerRoot: string;
}): SandboxFsBridge {
  const { hostRoot, containerRoot } = params;

  /** Map a filePath to a host-absolute path.
   *  - Container-absolute paths under containerRoot → hostRoot + relative
   *  - Already host-absolute paths → unchanged (pass-through)
   *  - Relative paths → resolved relative to cwd (or hostRoot)
   */
  function toHostPath(filePath: string, cwd?: string): string {
    if (path.isAbsolute(filePath)) {
      // Already a host-absolute path (passed in after bridge.resolvePath returned hostPath).
      // Map container-root prefixes; pass through genuine host-absolute paths.
      const normalizedContainerRoot = containerRoot.endsWith("/")
        ? containerRoot
        : `${containerRoot}/`;
      if (filePath === containerRoot) {
        return hostRoot;
      }
      if (filePath.startsWith(normalizedContainerRoot)) {
        return path.join(hostRoot, filePath.slice(normalizedContainerRoot.length));
      }
      // Already a real host absolute path (e.g. /private/tmp/openclaw-bind-xxx/output.txt).
      return filePath;
    }
    // Relative: resolve from cwd.
    return path.resolve(cwd ?? hostRoot, filePath);
  }

  return {
    resolvePath({ filePath, cwd }) {
      const hostPath = toHostPath(filePath, cwd);
      const rel = path.relative(hostRoot, hostPath);
      const containerPath = rel
        ? `${containerRoot}/${rel.split(path.sep).join("/")}`
        : containerRoot;
      return { hostPath, containerPath, relativePath: rel || "." };
    },

    async readFile({ filePath, cwd }) {
      return fs.readFile(toHostPath(filePath, cwd));
    },

    async writeFile({ filePath, cwd, data, encoding }) {
      const hp = toHostPath(filePath, cwd);
      await fs.mkdir(path.dirname(hp), { recursive: true });
      await fs.writeFile(hp, Buffer.isBuffer(data) ? data : Buffer.from(data, encoding ?? "utf8"));
    },

    async createFileExclusive({ filePath, cwd, data, encoding }) {
      const hp = toHostPath(filePath, cwd);
      await fs.mkdir(path.dirname(hp), { recursive: true });
      try {
        await fs.writeFile(
          hp,
          Buffer.isBuffer(data) ? data : Buffer.from(data, encoding ?? "utf8"),
          { flag: "wx" },
        );
        return "created";
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw err;
      }
    },

    async mkdirp({ filePath, cwd }) {
      await fs.mkdir(toHostPath(filePath, cwd), { recursive: true });
    },

    async remove({ filePath, cwd }) {
      await fs.rm(toHostPath(filePath, cwd), { force: true });
    },

    async rename({ from, to, cwd }) {
      await fs.rename(toHostPath(from, cwd), toHostPath(to, cwd));
    },

    async stat({ filePath, cwd }) {
      try {
        const s = await fs.stat(toHostPath(filePath, cwd));
        return {
          type: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
          size: s.size,
          mtimeMs: s.mtimeMs,
        };
      } catch {
        return null;
      }
    },
  };
}

async function withTempDirs<T>(
  fn: (dirs: { workspaceDir: string; bindHostDir: string }) => Promise<T>,
): Promise<T> {
  // On macOS, os.tmpdir() resolves through a symlink (/var -> /private/var).
  // Canonicalize both dirs so host-path comparisons are stable.
  const rawWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ws-"));
  const rawBind = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bind-"));
  const workspaceDir = await fs.realpath(rawWorkspace);
  const bindHostDir = await fs.realpath(rawBind);
  try {
    return await fn({ workspaceDir, bindHostDir });
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(bindHostDir, { recursive: true, force: true });
  }
}

describe("apply_patch on sandbox bind-mounted paths (issue #93140)", () => {
  it("accepts an Add hunk targeting a writable bind-mounted container path", async () => {
    await withTempDirs(async ({ workspaceDir, bindHostDir }) => {
      const bridge = createBindMountBridge({
        hostRoot: bindHostDir,
        containerRoot: "/bind",
      });

      const patch = `*** Begin Patch
*** Add File: /bind/output.txt
+generated content
*** End Patch`;

      const result = await applyPatch(patch, {
        cwd: workspaceDir,
        sandbox: { root: workspaceDir, bridge },
      });

      expect(result.summary.added).toContain("output.txt");
      const written = await fs.readFile(path.join(bindHostDir, "output.txt"), "utf8");
      expect(written).toBe("generated content\n");
    });
  });

  it("accepts an Update hunk targeting a writable bind-mounted container path", async () => {
    await withTempDirs(async ({ workspaceDir, bindHostDir }) => {
      // Pre-create the file on the host side of the bind mount.
      await fs.writeFile(path.join(bindHostDir, "report.txt"), "old content\n");

      const bridge = createBindMountBridge({
        hostRoot: bindHostDir,
        containerRoot: "/bind",
      });

      const patch = `*** Begin Patch
*** Update File: /bind/report.txt
@@
-old content
+new content
*** End Patch`;

      const result = await applyPatch(patch, {
        cwd: workspaceDir,
        sandbox: { root: workspaceDir, bridge },
      });

      expect(result.summary.modified).toContain("report.txt");
      const written = await fs.readFile(path.join(bindHostDir, "report.txt"), "utf8");
      expect(written).toBe("new content\n");
    });
  });

  it("accepts a Delete hunk targeting a writable bind-mounted container path", async () => {
    await withTempDirs(async ({ workspaceDir, bindHostDir }) => {
      await fs.writeFile(path.join(bindHostDir, "to-delete.txt"), "bye\n");

      const bridge = createBindMountBridge({
        hostRoot: bindHostDir,
        containerRoot: "/bind",
      });

      const patch = `*** Begin Patch
*** Delete File: /bind/to-delete.txt
*** End Patch`;

      const result = await applyPatch(patch, {
        cwd: workspaceDir,
        sandbox: { root: workspaceDir, bridge },
      });

      expect(result.summary.deleted).toContain("to-delete.txt");
      await expect(fs.access(path.join(bindHostDir, "to-delete.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("still accepts workspace-relative paths in the same sandbox session", async () => {
    await withTempDirs(async ({ workspaceDir, bindHostDir }) => {
      // Bridge that maps workspace-relative paths inside workspaceDir, plus /bind -> bindHostDir.
      // For this test we just verify workspace paths still work after removing the guard.
      const workspaceBridge: SandboxFsBridge = {
        resolvePath({ filePath }) {
          const containerWs = "/workspace";
          let hostPath: string;
          if (path.isAbsolute(filePath)) {
            // Could be a container-absolute path or already a host-absolute path.
            if (filePath.startsWith(`${containerWs}/`) || filePath === containerWs) {
              const rel = filePath === containerWs ? "" : filePath.slice(`${containerWs}/`.length);
              hostPath = rel ? path.join(workspaceDir, rel) : workspaceDir;
            } else {
              // Already a real host absolute path.
              hostPath = filePath;
            }
          } else {
            hostPath = path.join(workspaceDir, filePath);
          }
          const rel = path.relative(workspaceDir, hostPath);
          return {
            hostPath,
            containerPath: rel ? `${containerWs}/${rel.split(path.sep).join("/")}` : containerWs,
            relativePath: rel || ".",
          };
        },
        async readFile({ filePath }) {
          const hp = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
          return fs.readFile(hp);
        },
        async writeFile({ filePath, data, encoding }) {
          const hp = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
          await fs.mkdir(path.dirname(hp), { recursive: true });
          await fs.writeFile(
            hp,
            Buffer.isBuffer(data) ? data : Buffer.from(data, encoding ?? "utf8"),
          );
        },
        async createFileExclusive({ filePath, data, encoding }) {
          const hp = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
          await fs.mkdir(path.dirname(hp), { recursive: true });
          try {
            await fs.writeFile(
              hp,
              Buffer.isBuffer(data) ? data : Buffer.from(data, encoding ?? "utf8"),
              { flag: "wx" },
            );
            return "created";
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists";
            throw e;
          }
        },
        async mkdirp({ filePath }) {
          const hp = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
          await fs.mkdir(hp, { recursive: true });
        },
        async remove({ filePath }) {
          const hp = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
          await fs.rm(hp, { force: true });
        },
        async rename({ from, to }) {
          const fromHp = path.isAbsolute(from) ? from : path.join(workspaceDir, from);
          const toHp = path.isAbsolute(to) ? to : path.join(workspaceDir, to);
          await fs.rename(fromHp, toHp);
        },
        async stat({ filePath }) {
          try {
            const hp = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
            const s = await fs.stat(hp);
            return {
              type: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other",
              size: s.size,
              mtimeMs: s.mtimeMs,
            };
          } catch {
            return null;
          }
        },
      };

      const patch = `*** Begin Patch
*** Add File: notes.txt
+workspace note
*** End Patch`;

      const result = await applyPatch(patch, {
        cwd: workspaceDir,
        sandbox: { root: workspaceDir, bridge: workspaceBridge },
      });

      expect(result.summary.added).toContain("notes.txt");
      const written = await fs.readFile(path.join(workspaceDir, "notes.txt"), "utf8");
      expect(written).toBe("workspace note\n");
    });
  });
});
