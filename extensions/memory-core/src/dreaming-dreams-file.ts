// Memory Core helpers for safe managed DREAMS.md updates.
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { replaceManagedMarkdownBlock } from "openclaw/plugin-sdk/memory-host-markdown";
import { readRegularFile, replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";

export const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"] as const;
const DEEP_START_MARKER = "<!-- openclaw:dreaming:deep:start -->";
const DEEP_END_MARKER = "<!-- openclaw:dreaming:deep:end -->";

export async function resolveDreamsPath(workspaceDir: string): Promise<string> {
  for (const name of DREAMS_FILENAMES) {
    const target = path.join(workspaceDir, name);
    try {
      await fs.access(target);
      return target;
    } catch (err) {
      if (extractErrorCode(err) !== "ENOENT") {
        throw err;
      }
    }
  }
  return path.join(workspaceDir, DREAMS_FILENAMES[0]);
}

function isEmptyDreamsReadError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "not-found" ||
    code === "not-file" ||
    code === "path-alias" ||
    code === "path-mismatch" ||
    code === "symlink"
  ) {
    return true;
  }
  return err instanceof Error && err.message === "path must be a regular file";
}

export async function readDreamsFile(dreamsPath: string): Promise<string> {
  try {
    return (await readRegularFile({ filePath: dreamsPath })).buffer.toString("utf-8");
  } catch (err) {
    if (isEmptyDreamsReadError(err)) {
      return "";
    }
    throw err;
  }
}

async function assertSafeDreamsPath(dreamsPath: string): Promise<void> {
  const stat = await fs.lstat(dreamsPath).catch((err: unknown) => {
    if (extractErrorCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!stat) {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error("Refusing to write symlinked DREAMS.md");
  }
  if (!stat.isFile()) {
    throw new Error("Refusing to write non-file DREAMS.md");
  }
}

async function writeDreamsFileAtomic(dreamsPath: string, content: string): Promise<void> {
  await assertSafeDreamsPath(dreamsPath);
  await replaceFileAtomic({
    filePath: dreamsPath,
    content,
    mode: 0o600,
    preserveExistingMode: true,
    tempPrefix: `${path.basename(dreamsPath)}.dreams`,
    throwOnCleanupError: true,
  });
}

export async function updateDreamsFile<T>(params: {
  workspaceDir: string;
  updater: (
    existing: string,
    dreamsPath: string,
  ) =>
    | Promise<{ content: string; result: T; shouldWrite?: boolean }>
    | {
        content: string;
        result: T;
        shouldWrite?: boolean;
      };
}): Promise<T> {
  // Read and replace under the purge owner's lock so an awaited diary update
  // cannot write a pre-deletion file snapshot back over the scrubbed contents.
  return await withMemoryWorkspaceLock(params.workspaceDir, async () => {
    const dreamsPath = await resolveDreamsPath(params.workspaceDir);
    await fs.mkdir(path.dirname(dreamsPath), { recursive: true });
    const existing = await readDreamsFile(dreamsPath);
    const { content, result, shouldWrite = true } = await params.updater(existing, dreamsPath);
    if (shouldWrite) {
      await writeDreamsFileAtomic(dreamsPath, content.endsWith("\n") ? content : `${content}\n`);
    }
    return result;
  });
}

export async function updateDeepDreamsFile(params: {
  workspaceDir: string;
  bodyLines: string[];
}): Promise<string> {
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No durable changes.";
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => ({
      content: replaceManagedMarkdownBlock({
        original: existing,
        heading: "## Deep Sleep",
        startMarker: DEEP_START_MARKER,
        endMarker: DEEP_END_MARKER,
        body,
      }),
      result: dreamsPath,
    }),
  });
}
