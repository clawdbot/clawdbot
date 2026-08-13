/**
 * Runtime apply_patch tool.
 * Stages parsed add/update/delete/move hunks against a virtual overlay, then
 * commits them through guarded host or sandbox filesystem operations.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { createAbortError } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { PATH_ALIAS_POLICIES, type PathAliasPolicy } from "../infra/path-alias-guards.js";
import {
  type ApplyPatchFileOptions,
  createPatchTarget,
  type PatchEntryKind,
  type PatchFileOps,
  resolvePatchFileOps,
  type SandboxApplyPatchConfig,
} from "./apply-patch-file-ops.js";
import { type Hunk, parsePatchText } from "./apply-patch-parse.js";
import { applyUpdateHunk } from "./apply-patch-update.js";
import type { MemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import { resolvePathFromInput } from "./path-policy.js";
import type { AgentTool } from "./runtime/index.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import { withFileMutationQueues } from "./sessions/tools/file-mutation-queue.js";

export type ApplyPatchSummary = {
  added: string[];
  modified: string[];
  deleted: string[];
};

type ApplyPatchResult = {
  summary: ApplyPatchSummary;
  text: string;
  noOp?: boolean;
};

type ApplyPatchToolDetails = {
  summary: ApplyPatchSummary;
};

function normalizeUpdateComparison(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length === 0 || normalized.endsWith("\n")) {
    return normalized;
  }
  return `${normalized}\n`;
}

type ApplyPatchOptions = ApplyPatchFileOptions & {
  signal?: AbortSignal;
};

const applyPatchSchema = Type.Object({
  input: Type.String({
    description: "Patch content using the *** Begin Patch/End Patch format.",
  }),
});

const ApplyPatchToolOutputSchema = Type.Object(
  {
    summary: Type.Object(
      {
        added: Type.Array(Type.String()),
        modified: Type.Array(Type.String()),
        deleted: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Create the agent tool wrapper for applying patch-envelope input. */
export function createApplyPatchTool(
  options: {
    cwd?: string;
    sandbox?: SandboxApplyPatchConfig;
    workspaceOnly?: boolean;
    memoryWriteProvenance?: MemoryWriteProvenanceObserver;
  } = {},
): AgentTool<typeof applyPatchSchema, ApplyPatchToolDetails> {
  const cwd = options.cwd ?? process.cwd();
  const sandbox = options.sandbox;
  const workspaceOnly = options.workspaceOnly !== false;

  return {
    name: "apply_patch",
    label: "apply_patch",
    description: "Patch one/many files. Input requires *** Begin Patch and *** End Patch.",
    parameters: applyPatchSchema,
    outputSchema: ApplyPatchToolOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as { input?: string };
      const input = typeof params.input === "string" ? params.input : "";
      if (!input.trim()) {
        throw new Error("Provide a patch input.");
      }
      if (signal?.aborted) {
        throw createAbortError("Aborted");
      }

      const result = await applyPatch(input, {
        cwd,
        sandbox,
        workspaceOnly,
        memoryWriteProvenance: options.memoryWriteProvenance,
        signal,
      });

      return {
        content: [{ type: "text", text: result.text }],
        details: { summary: result.summary },
        ...(result.noOp ? { terminate: true } : {}),
      };
    },
  };
}

/** Parse and apply a patch envelope to the configured filesystem target. */
async function applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
  const parsed = parsePatchText(input);
  if (parsed.hunks.length === 0) {
    throw new Error("No files were modified.");
  }

  const fileOps = resolvePatchFileOps(options);
  const resolvedHunks: ResolvedPatchHunk[] = [];
  for (const hunk of parsed.hunks) {
    if (options.signal?.aborted) {
      throw createAbortError("Aborted");
    }
    if (hunk.kind === "delete") {
      resolvedHunks.push({
        hunk,
        target: await resolvePatchPath(hunk.path, options, PATH_ALIAS_POLICIES.unlinkTarget),
      });
      continue;
    }
    resolvedHunks.push({
      hunk,
      target: await resolvePatchPath(hunk.path, options),
      moveTarget:
        hunk.kind === "update" && hunk.movePath
          ? await resolvePatchPath(hunk.movePath, options)
          : undefined,
    });
  }

  const queuedPaths = resolvedHunks.flatMap((entry) => [
    entry.target.resolved,
    ...(entry.moveTarget ? [entry.moveTarget.resolved] : []),
  ]);
  return await withFileMutationQueues(queuedPaths, async () => {
    const staged = await stagePatchHunks(resolvedHunks, fileOps, options);
    if (options.signal?.aborted) {
      throw createAbortError("Aborted");
    }
    await commitStagedPatchOps(staged.ops, fileOps);

    const { summary, noOpPaths } = staged;
    const noOp = noOpPaths.size > 0 && Object.values(summary).every((paths) => paths.length === 0);
    return {
      summary,
      text: noOp
        ? `No changes made to ${Array.from(noOpPaths).join(", ")}.`
        : formatSummary(summary),
      ...(noOp ? { noOp: true } : {}),
    };
  });
}

type PatchTarget = { resolved: string; display: string };

type ResolvedPatchHunk = { hunk: Hunk; target: PatchTarget; moveTarget?: PatchTarget };

type StagedPatchOp =
  | { kind: "create"; target: PatchTarget; contents: string; hint: string }
  | { kind: "write"; target: PatchTarget; contents: string }
  | { kind: "remove"; target: PatchTarget };

async function stagePatchHunks(
  resolvedHunks: ResolvedPatchHunk[],
  fileOps: PatchFileOps,
  options: ApplyPatchOptions,
): Promise<{ ops: StagedPatchOp[]; summary: ApplyPatchSummary; noOpPaths: Set<string> }> {
  const summary: ApplyPatchSummary = {
    added: [],
    modified: [],
    deleted: [],
  };
  const seen = {
    added: new Set<string>(),
    modified: new Set<string>(),
    deleted: new Set<string>(),
  };
  const noOpPaths = new Set<string>();
  const stagedContents = new Map<string, string | null>();
  const stagedDirs = new Set<string>();
  const ops: StagedPatchOp[] = [];

  const readStaged = async (filePath: string): Promise<string> => {
    const stagedFile = stagedContents.get(filePath);
    if (stagedFile === null) {
      throw new Error("File was deleted earlier in this patch.");
    }
    return stagedFile ?? (await fileOps.readFile(filePath));
  };
  const stagedEntryKind = async (filePath: string): Promise<PatchEntryKind> => {
    if (stagedDirs.has(filePath)) {
      return "directory";
    }
    const stagedFile = stagedContents.get(filePath);
    if (stagedFile === undefined) {
      return await fileOps.entryKind(filePath);
    }
    return stagedFile === null ? null : "file";
  };
  const stageParentDirs = async (target: PatchTarget) => {
    let current = path.dirname(target.resolved);
    let currentDisplay = path.dirname(target.display);
    while (current !== path.dirname(current) && !stagedDirs.has(current)) {
      const stagedFile = stagedContents.get(current);
      if (stagedFile === undefined) {
        const kind = await fileOps.entryKind(current);
        if (kind === "file") {
          throw new Error(
            `Cannot create ${target.display}: ${currentDisplay} is an existing file, not a directory. Delete it earlier in the same patch or choose another destination.`,
          );
        }
        if (kind !== null) {
          return;
        }
      } else if (stagedFile !== null) {
        throw new Error(
          `Cannot create ${target.display}: ${currentDisplay} is created as a file earlier in this patch. Reorder the hunks or choose another destination.`,
        );
      }
      stagedDirs.add(current);
      current = path.dirname(current);
      currentDisplay = path.dirname(currentDisplay);
    }
  };
  const stageCreate = async (params: {
    target: PatchTarget;
    parentPath: string;
    contents: string;
    hint: string;
  }) => {
    await assertPatchParentPath(params.parentPath, options);
    if (stagedDirs.has(params.target.resolved)) {
      throw new Error(
        `Cannot create ${params.target.display}: an earlier hunk in this patch creates it as a directory. Reorder the hunks or choose another destination.`,
      );
    }
    if ((await stagedEntryKind(params.target.resolved)) !== null) {
      throw new Error(
        `Cannot create ${params.target.display}: the file already exists. ${params.hint}`,
      );
    }
    await stageParentDirs(params.target);
    ops.push({
      kind: "create",
      target: params.target,
      contents: params.contents,
      hint: params.hint,
    });
    stagedContents.set(params.target.resolved, params.contents);
  };

  for (const { hunk, target, moveTarget } of resolvedHunks) {
    if (options.signal?.aborted) {
      throw createAbortError("Aborted");
    }

    if (hunk.kind === "add") {
      await stageCreate({
        target,
        parentPath: hunk.path,
        contents: hunk.contents,
        hint: `Use "*** Update File: ${target.display}" to change it, or delete it earlier in the same patch.`,
      });
      recordSummary(summary, seen, "added", target.display);
      continue;
    }

    if (hunk.kind === "delete") {
      const entryKind = await stagedEntryKind(target.resolved);
      if (entryKind === null) {
        throw new Error(`Cannot delete ${target.display}: the file was not found.`);
      }
      if (entryKind === "directory") {
        throw new Error(
          `Cannot delete ${target.display}: it is a directory, not a file. Delete each file inside it with its own hunk.`,
        );
      }
      ops.push({ kind: "remove", target });
      stagedContents.set(target.resolved, null);
      recordSummary(summary, seen, "deleted", target.display);
      continue;
    }

    const applied = await applyUpdateHunk(target.resolved, hunk.chunks, { readFile: readStaged });
    const moveResolvesToSource =
      moveTarget !== undefined &&
      path.resolve(moveTarget.resolved) === path.resolve(target.resolved);
    if (hunk.movePath && moveTarget && !moveResolvesToSource) {
      noOpPaths.delete(target.display);
      await stageCreate({
        target: moveTarget,
        parentPath: hunk.movePath,
        contents: applied,
        hint: "Delete it earlier in the same patch to replace it.",
      });
      ops.push({ kind: "remove", target });
      stagedContents.set(target.resolved, null);
      recordSummary(summary, seen, "modified", moveTarget.display);
      continue;
    }

    const existing = await readStaged(target.resolved);
    if (normalizeUpdateComparison(existing) === normalizeUpdateComparison(applied)) {
      noOpPaths.add(target.display);
      continue;
    }
    noOpPaths.delete(target.display);
    ops.push({ kind: "write", target, contents: applied });
    stagedContents.set(target.resolved, applied);
    recordSummary(summary, seen, "modified", target.display);
  }

  return { ops, summary, noOpPaths };
}

const STAGED_OP_APPLIED_LABEL = {
  create: "added",
  write: "modified",
  remove: "deleted",
} as const;

async function commitStagedPatchOps(ops: StagedPatchOp[], fileOps: PatchFileOps) {
  const applied: string[] = [];
  for (const op of ops) {
    try {
      if (op.kind === "create") {
        await ensureDir(op.target.resolved, fileOps);
        await createPatchTarget({
          target: op.target,
          contents: op.contents,
          ops: fileOps,
          hint: op.hint,
        });
      } else if (op.kind === "write") {
        await fileOps.writeFile(op.target.resolved, op.contents);
      } else {
        await fileOps.remove(op.target.resolved);
      }
    } catch (error) {
      if (applied.length === 0) {
        throw error;
      }
      throw new Error(
        `${formatErrorMessage(error)} The patch was partially applied before this failure: ${applied.join(", ")}. The workspace no longer matches the patch input.`,
        { cause: error },
      );
    }
    applied.push(`${STAGED_OP_APPLIED_LABEL[op.kind]} ${op.target.display}`);
  }
}

function recordSummary(
  summary: ApplyPatchSummary,
  seen: {
    added: Set<string>;
    modified: Set<string>;
    deleted: Set<string>;
  },
  bucket: keyof ApplyPatchSummary,
  value: string,
) {
  if (seen[bucket].has(value)) {
    return;
  }
  seen[bucket].add(value);
  summary[bucket].push(value);
}

function formatSummary(summary: ApplyPatchSummary): string {
  const lines = ["Success. Updated the following files:"];
  for (const file of summary.added) {
    lines.push(`A ${file}`);
  }
  for (const file of summary.modified) {
    lines.push(`M ${file}`);
  }
  for (const file of summary.deleted) {
    lines.push(`D ${file}`);
  }
  return lines.join("\n");
}

async function ensureDir(filePath: string, ops: PatchFileOps) {
  const parent = path.dirname(filePath);
  if (!parent || parent === ".") {
    return;
  }
  await ops.mkdirp(parent);
}

async function assertPatchParentPath(filePath: string, options: ApplyPatchOptions) {
  if (options.workspaceOnly === false || options.sandbox) {
    return;
  }
  const parent = path.dirname(filePath);
  if (!parent || parent === ".") {
    return;
  }
  await assertSandboxPath({
    filePath: parent,
    cwd: options.cwd,
    root: options.cwd,
  });
  await assertNoExistingParentAliases({
    parentPath: resolvePathFromInput(parent, options.cwd),
    rootPath: options.cwd,
  });
}

async function assertNoExistingParentAliases(params: { parentPath: string; rootPath: string }) {
  const rootPath = path.resolve(params.rootPath);
  const parentPath = path.resolve(params.parentPath);
  const relative = path.relative(rootPath, parentPath);
  if (!relative || relative === "" || relativePathEscapesRoot(relative)) {
    return;
  }

  let current = rootPath;
  for (const segment of relative.split(path.sep)) {
    if (!segment) {
      continue;
    }
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Path alias under sandbox root: ${path.relative(rootPath, current)}`);
    }
  }
}

async function resolvePatchPath(
  filePath: string,
  options: ApplyPatchOptions,
  aliasPolicy: PathAliasPolicy = PATH_ALIAS_POLICIES.strict,
): Promise<{ resolved: string; display: string }> {
  if (options.sandbox) {
    const resolved = options.sandbox.bridge.resolvePath({
      filePath,
      cwd: options.cwd,
    });
    if (options.workspaceOnly !== false && resolved.hostPath) {
      await assertSandboxPath({
        filePath: resolved.hostPath,
        cwd: options.cwd,
        root: options.cwd,
        allowFinalSymlinkForUnlink: aliasPolicy.allowFinalSymlinkForUnlink,
        allowFinalHardlinkForUnlink: aliasPolicy.allowFinalHardlinkForUnlink,
      });
    }
    return {
      resolved: resolved.hostPath ?? resolved.containerPath,
      display: resolved.relativePath || resolved.containerPath,
    };
  }

  const workspaceOnly = options.workspaceOnly !== false;
  const resolved = workspaceOnly
    ? (
        await assertSandboxPath({
          filePath,
          cwd: options.cwd,
          root: options.cwd,
          allowFinalSymlinkForUnlink: aliasPolicy.allowFinalSymlinkForUnlink,
          allowFinalHardlinkForUnlink: aliasPolicy.allowFinalHardlinkForUnlink,
        })
      ).resolved
    : resolvePathFromInput(filePath, options.cwd);
  return {
    resolved,
    display: toDisplayPath(resolved, options.cwd),
  };
}

function toDisplayPath(resolved: string, cwd: string): string {
  const relative = path.relative(cwd, resolved);
  if (!relative || relative === "") {
    return path.basename(resolved);
  }
  if (relativePathEscapesRoot(relative)) {
    return resolved;
  }
  return relative;
}

function relativePathEscapesRoot(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    path.isAbsolute(relativePath)
  );
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.applyPatchTestApi")] = {
    applyPatch,
  };
}
