import syncFs from "node:fs";
import fs from "node:fs/promises";
import { openRootFile, type RootFileOpenResult } from "../infra/boundary-file-read.js";
import { FsSafeError, root as fsRoot } from "../infra/fs-safe.js";
import { toRelativeSandboxPath } from "./path-policy.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { decodeUtf8File } from "./utf8-file.js";

export type SandboxApplyPatchConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

export type ApplyPatchFileOptions = {
  cwd: string;
  sandbox?: SandboxApplyPatchConfig;
  /** Restrict patch paths to the workspace root (cwd). Default: true. Set false to opt out. */
  workspaceOnly?: boolean;
};

type PatchCreateOutcome = "created" | "exists";

export type PatchFileOps = {
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  createFileExclusive: (filePath: string, content: string) => Promise<PatchCreateOutcome>;
  remove: (filePath: string) => Promise<void>;
  mkdirp: (dir: string) => Promise<void>;
};

export async function createPatchTarget(params: {
  target: { resolved: string; display: string };
  contents: string;
  ops: PatchFileOps;
  hint: string;
}) {
  const outcome = await params.ops.createFileExclusive(params.target.resolved, params.contents);
  if (outcome === "exists") {
    throw new Error(
      `Cannot create ${params.target.display}: the file already exists. ${params.hint}`,
    );
  }
}

export function resolvePatchFileOps(options: ApplyPatchFileOptions): PatchFileOps {
  if (options.sandbox) {
    const { root, bridge } = options.sandbox;
    return {
      readFile: async (filePath) => {
        const buf = await bridge.readFile({ filePath, cwd: root });
        return decodeUtf8File(buf, filePath);
      },
      writeFile: (filePath, content) => bridge.writeFile({ filePath, cwd: root, data: content }),
      createFileExclusive: (filePath, content) => {
        if (!bridge.createFileExclusive) {
          throw new Error(
            "Sandbox filesystem bridge does not support atomic file creation; refusing to overwrite an existing path.",
          );
        }
        return bridge.createFileExclusive({ filePath, cwd: root, data: content });
      },
      remove: (filePath) => bridge.remove({ filePath, cwd: root, force: false }),
      mkdirp: (dir) => bridge.mkdirp({ filePath: dir, cwd: root }),
    };
  }

  if (options.workspaceOnly === false) {
    return {
      readFile: async (filePath) => decodeUtf8File(await fs.readFile(filePath), filePath),
      writeFile: async (filePath, content) => {
        await fs.writeFile(filePath, content, "utf8");
      },
      createFileExclusive: async (filePath, content) => {
        try {
          await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
          return "created";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return "exists";
          }
          throw error;
        }
      },
      remove: (filePath) => fs.rm(filePath),
      mkdirp: async (dir) => {
        await fs.mkdir(dir, { recursive: true });
      },
    };
  }

  const rootPromise = fsRoot(options.cwd);
  return {
    readFile: async (filePath) => {
      const opened = await openRootFile({
        absolutePath: filePath,
        rootPath: options.cwd,
        boundaryLabel: "workspace root",
      });
      assertBoundaryRead(opened, filePath);
      try {
        return decodeUtf8File(syncFs.readFileSync(opened.fd), filePath);
      } finally {
        syncFs.closeSync(opened.fd);
      }
    },
    writeFile: async (filePath, content) => {
      const relative = toRelativeSandboxPath(options.cwd, filePath);
      await (await rootPromise).write(relative, content, { encoding: "utf8" });
    },
    createFileExclusive: async (filePath, content) => {
      const relative = toRelativeSandboxPath(options.cwd, filePath);
      try {
        await (await rootPromise).create(relative, content, { encoding: "utf8" });
        return "created";
      } catch (error) {
        // fs-safe opens an existing destination before its O_EXCL commit. A final
        // symlink is rejected during that probe, but for create semantics it is
        // still an occupied destination and must fail closed.
        if (
          error instanceof FsSafeError &&
          (error.code === "already-exists" || error.code === "symlink")
        ) {
          return "exists";
        }
        throw error;
      }
    },
    remove: async (filePath) => {
      const relative = toRelativeSandboxPath(options.cwd, filePath);
      await (await rootPromise).remove(relative);
    },
    mkdirp: async (dir) => {
      const relative = toRelativeSandboxPath(options.cwd, dir, { allowRoot: true });
      const root = await rootPromise;
      if (relative === "" || relative === ".") {
        await root.ensureRoot();
        return;
      }
      await root.mkdir(relative);
    },
  };
}

function assertBoundaryRead(
  opened: RootFileOpenResult,
  targetPath: string,
): asserts opened is Extract<RootFileOpenResult, { ok: true }> {
  if (opened.ok) {
    return;
  }
  const reason = opened.reason === "validation" ? "unsafe path" : "path not found";
  throw new Error(`Failed boundary read for ${targetPath} (${reason})`);
}
