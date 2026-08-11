import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  openRootFileFollowingParents,
  type RootFileOpenResult,
} from "../infra/boundary-file-read.js";
import {
  canonicalPathFromExistingAncestor,
  FsSafeError,
  root as fsRoot,
} from "../infra/fs-safe.js";
import {
  type MemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";
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
  memoryWriteProvenance?: MemoryWriteProvenanceObserver;
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
    return withPatchMemoryWriteProvenance({
      observer: options.memoryWriteProvenance,
      operations: {
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
      },
    });
  }

  if (options.workspaceOnly === false) {
    return withPatchMemoryWriteProvenance({
      observer: options.memoryWriteProvenance,
      operations: {
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
      },
    });
  }

  const rootPromise = fsRoot(options.cwd);
  // Mirror the read path: canonicalize contained symlink parents so a patch
  // that reads through a directory alias can also mutate through it. Escaping
  // aliases still fail the containment check against the canonical root.
  const toCanonicalMutationRelative = async (
    filePath: string,
    pathOptions?: { allowRoot?: boolean },
  ): Promise<string> => {
    const absolute = path.resolve(options.cwd, filePath);
    let canonicalAbsolute = absolute;
    try {
      const canonicalParent = await canonicalPathFromExistingAncestor(path.dirname(absolute));
      canonicalAbsolute = path.join(canonicalParent, path.basename(absolute));
    } catch {
      // Keep the lexical path; the containment check below owns the failure.
    }
    const canonicalCwd = await fs.realpath(options.cwd).catch(() => options.cwd);
    return toRelativeSandboxPath(canonicalCwd, canonicalAbsolute, pathOptions);
  };
  return withPatchMemoryWriteProvenance({
    observer: options.memoryWriteProvenance,
    operations: {
      readFile: async (filePath) => {
        const opened = await openRootFileFollowingParents({
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
        const relative = await toCanonicalMutationRelative(filePath);
        await (await rootPromise).write(relative, content, { encoding: "utf8" });
      },
      createFileExclusive: async (filePath, content) => {
        const relative = await toCanonicalMutationRelative(filePath);
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
        const relative = await toCanonicalMutationRelative(filePath);
        await (await rootPromise).remove(relative);
      },
      mkdirp: async (dir) => {
        const relative = await toCanonicalMutationRelative(dir, { allowRoot: true });
        const root = await rootPromise;
        if (relative === "" || relative === ".") {
          await root.ensureRoot();
          return;
        }
        await root.mkdir(relative);
      },
    },
  });
}

class PatchCreateExistsSignal extends Error {}

function withPatchMemoryWriteProvenance(params: {
  operations: PatchFileOps;
  observer: MemoryWriteProvenanceObserver | undefined;
}): PatchFileOps {
  const operations = withMemoryWriteProvenance(params.operations, params.observer);
  if (!params.observer) {
    return operations;
  }
  return {
    ...operations,
    createFileExclusive: async (filePath, content) => {
      if (!params.observer?.classifies(filePath)) {
        return params.operations.createFileExclusive(filePath, content);
      }
      try {
        await params.observer.write({
          absolutePath: filePath,
          contentBefore: "",
          contentAfter: content,
          commit: async () => {
            if ((await params.operations.createFileExclusive(filePath, content)) === "exists") {
              throw new PatchCreateExistsSignal();
            }
          },
        });
        return "created";
      } catch (error) {
        if (error instanceof PatchCreateExistsSignal) {
          return "exists";
        }
        throw error;
      }
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
  const error = new Error(`Failed boundary read for ${targetPath} (${reason})`) as Error & {
    code?: string;
  };
  const sourceCode =
    opened.error && typeof opened.error === "object" && "code" in opened.error
      ? opened.error.code
      : undefined;
  if (sourceCode === "ENOENT" || sourceCode === "ENOTDIR") {
    // Preserve the producer's classification so provenance observers do not parse messages.
    error.code = sourceCode;
  }
  throw error;
}
