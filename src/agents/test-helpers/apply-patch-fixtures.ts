import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";

export async function withCanonicalTempDir<T>(fn: (dir: string) => Promise<T>) {
  // realpath: production sandbox checks compare against canonical paths; on macOS
  // os.tmpdir() is a /var -> /private/var symlink, which otherwise trips the guard.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-")));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export function createMemoryPatchSandbox(
  initialFiles: Record<string, string | Buffer> = {},
  options: { supportsExclusiveCreate?: boolean } = {},
) {
  const files = new Map<string, string | Buffer>(
    Object.entries(initialFiles).map(([filePath, contents]) => [`/sandbox/${filePath}`, contents]),
  );
  const writeFile = vi.fn(async ({ filePath, data }) => {
    files.set(filePath, Buffer.isBuffer(data) ? Buffer.from(data) : data);
  });
  const createFileExclusive = vi.fn(async ({ filePath, data }) => {
    if (files.has(filePath)) {
      return "exists" as const;
    }
    files.set(filePath, Buffer.isBuffer(data) ? Buffer.from(data) : data);
    return "created" as const;
  });
  const mkdirp = vi.fn(async () => {});
  const bridge: SandboxFsBridge = {
    resolvePath: ({ filePath }) => ({
      relativePath: filePath,
      containerPath: `/sandbox/${filePath}`,
    }),
    readFile: async ({ filePath }) => {
      const contents = files.get(filePath);
      return typeof contents === "string"
        ? Buffer.from(contents, "utf8")
        : Buffer.from(contents ?? "");
    },
    writeFile,
    ...(options.supportsExclusiveCreate === false ? {} : { createFileExclusive }),
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
    mkdirp,
  };
  return {
    files,
    bridge,
    writeFile,
    createFileExclusive,
    mkdirp,
    options: {
      cwd: "/local/workspace",
      sandbox: {
        root: "/local/workspace",
        bridge,
      },
    },
  };
}
