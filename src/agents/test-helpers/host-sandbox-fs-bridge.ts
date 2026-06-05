/**
 * Host-backed sandbox filesystem bridge fixtures.
 *
 * Adapts a path resolver into the sandbox fs bridge contract for local tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSandboxPath } from "../sandbox-paths.js";
import type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "../sandbox/fs-bridge.js";

/** Creates a sandbox fs bridge from a caller-provided path resolver. */
export function createSandboxFsBridgeFromResolver(
  resolvePath: (filePath: string, cwd?: string) => SandboxResolvedPath,
): SandboxFsBridge {
  return {
    resolvePath: ({ filePath, cwd }) => resolvePath(filePath, cwd),
    readFile: async ({ filePath, cwd }) => {
      const target = resolvePath(filePath, cwd);
      if (!target.hostPath) {
        throw new Error(`Expected hostPath for ${target.containerPath}`);
      }
      return fs.readFile(target.hostPath);
    },
    writeFile: async ({ filePath, cwd, data, mkdir = true }) => {
      const target = resolvePath(filePath, cwd);
      if (!target.hostPath) {
        throw new Error(`Expected hostPath for ${target.containerPath}`);
      }
      if (mkdir) {
        await fs.mkdir(path.dirname(target.hostPath), { recursive: true });
      }
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      await fs.writeFile(target.hostPath, buffer);
    },
    mkdirp: async ({ filePath, cwd }) => {
      const target = resolvePath(filePath, cwd);
      if (!target.hostPath) {
        throw new Error(`Expected hostPath for ${target.containerPath}`);
      }
      await fs.mkdir(target.hostPath, { recursive: true });
    },
    remove: async ({ filePath, cwd, recursive, force }) => {
      const target = resolvePath(filePath, cwd);
      if (!target.hostPath) {
        throw new Error(`Expected hostPath for ${target.containerPath}`);
      }
      await fs.rm(target.hostPath, {
        recursive: recursive ?? false,
        force: force ?? false,
      });
    },
    rename: async ({ from, to, cwd }) => {
      const source = resolvePath(from, cwd);
      const target = resolvePath(to, cwd);
      if (!source.hostPath || !target.hostPath) {
        throw new Error(
          `Expected hostPath for rename: ${source.containerPath} -> ${target.containerPath}`,
        );
      }
      await fs.mkdir(path.dirname(target.hostPath), { recursive: true });
      await fs.rename(source.hostPath, target.hostPath);
    },
    stat: async ({ filePath, cwd }) => {
      try {
        const target = resolvePath(filePath, cwd);
        if (!target.hostPath) {
          throw new Error(`Expected hostPath for ${target.containerPath}`);
        }
        const stats = await fs.stat(target.hostPath);
        return {
          type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        } satisfies SandboxFsStat;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
  };
}

/** Creates a sandbox fs bridge rooted at a real host directory. */
export function createHostSandboxFsBridge(rootDir: string): SandboxFsBridge {
  const root = path.resolve(rootDir);

  const resolvePath = (filePath: string, cwd?: string): SandboxResolvedPath => {
    const resolved = resolveSandboxPath({
      filePath,
      cwd: cwd ?? root,
      root,
    });
    const relativePath = resolved.relative
      ? resolved.relative.split(path.sep).filter(Boolean).join(path.posix.sep)
      : "";
    const containerPath = relativePath ? path.posix.join("/workspace", relativePath) : "/workspace";
    return {
      hostPath: resolved.resolved,
      relativePath,
      containerPath,
    };
  };

  return createSandboxFsBridgeFromResolver(resolvePath);
}
