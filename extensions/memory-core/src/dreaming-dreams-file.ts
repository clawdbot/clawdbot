// Memory Core helpers for safe managed DREAMS.md updates.
import { createReadStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import {
  resolvePreferredOpenClawTmpDir,
  openLocalFileSafely,
  readRegularFile,
  replaceFileAtomic,
  root,
} from "openclaw/plugin-sdk/security-runtime";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";

export const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"] as const;
const DEEP_START_MARKER = "<!-- openclaw:dreaming:deep:start -->";
const DEEP_END_MARKER = "<!-- openclaw:dreaming:deep:end -->";
const DREAMS_FILE_LOCKS_KEY = Symbol.for("openclaw.memoryCore.dreamingNarrative.fileLocks");
const MEMORY_DREAMING_MARKDOWN_MAX_BYTES = 16 * 1024 * 1024;

type DreamsFileLockEntry = {
  withLock: ReturnType<typeof createAsyncLock>;
  refs: number;
};

type ManagedMarkdownUpdateParams = {
  filePath: string;
  expectedRealPath?: string;
  workspaceDir?: string;
  heading: string;
  startMarker: string;
  endMarker: string;
  body: string;
  tempPrefix: string;
  allowSymlink?: boolean;
  creationMode?: number;
};

const dreamsFileLocks = resolveGlobalMap<string, DreamsFileLockEntry>(DREAMS_FILE_LOCKS_KEY);

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

async function resolveSafeMarkdownPath(
  filePath: string,
  allowSymlink: boolean,
  workspaceDir?: string,
): Promise<{ filePath: string; realPath?: string; stat: Stats } | null> {
  const pathDescription = DREAMS_FILENAMES.includes(
    // SAFETY: basename is compared only against the literal DREAMS filename union.
    path.basename(filePath) as (typeof DREAMS_FILENAMES)[number],
  )
    ? "DREAMS.md"
    : `markdown file: ${filePath}`;
  let workspaceMemoryDir: string | undefined;
  if (allowSymlink) {
    if (!workspaceDir) {
      throw new Error(`Refusing to write ${pathDescription} without a workspace directory`);
    }
    const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
    // Keep the configured memory directory itself as the lexical boundary.
    // Resolving it would make an external `memory` symlink the new trusted
    // root and defeat the containment check.
    workspaceMemoryDir = path.join(canonicalWorkspaceDir, "memory");
    const canonicalParent = await fs.realpath(path.dirname(filePath));
    if (!isPathInside(workspaceMemoryDir, canonicalParent)) {
      throw new Error(`Refusing to write ${pathDescription} outside workspace memory directory`);
    }
  }
  let canonicalFilePath: string | undefined;
  try {
    // Capture the canonical regular-file path before the lstat below. If the
    // pathname is swapped after this check, streaming will compare the opened
    // handle's real path with this captured value instead of following the
    // replacement pathname.
    canonicalFilePath = await fs.realpath(filePath);
  } catch (err) {
    if (extractErrorCode(err) !== "ENOENT") {
      throw err;
    }
  }
  const stat = await fs.lstat(filePath).catch((err: unknown) => {
    if (extractErrorCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink()) {
    if (!allowSymlink) {
      throw new Error(`Refusing to write symlinked ${pathDescription}`);
    }
    const resolvedPath = await fs.realpath(filePath);
    if (!workspaceMemoryDir || !isPathInside(workspaceMemoryDir, resolvedPath)) {
      throw new Error(`Refusing to write ${pathDescription} outside workspace memory directory`);
    }
    const resolvedStat = await fs.stat(resolvedPath);
    if (!resolvedStat.isFile()) {
      throw new Error(`Refusing to write non-file ${pathDescription}`);
    }
    return { filePath: resolvedPath, realPath: resolvedPath, stat: resolvedStat };
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to write non-file ${pathDescription}`);
  }
  return { filePath, realPath: canonicalFilePath, stat };
}

async function assertSafeDreamsPath(dreamsPath: string): Promise<void> {
  await resolveSafeMarkdownPath(dreamsPath, false);
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

function buildManagedMarkdownBlock(params: ManagedMarkdownUpdateParams): string {
  return `${params.heading}\n${params.startMarker}\n${params.body}\n${params.endMarker}`;
}

function preserveCodePointBoundary(value: string, endIndex: number): number {
  if (endIndex <= 0 || endIndex >= value.length) {
    return endIndex;
  }
  const previous = value.charCodeAt(endIndex - 1);
  const next = value.charCodeAt(endIndex);
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return splitsSurrogatePair ? endIndex - 1 : endIndex;
}

async function replaceManagedMarkdownBlockStreaming(
  params: ManagedMarkdownUpdateParams,
): Promise<void> {
  if (!params.workspaceDir) {
    throw new Error("Streaming managed Markdown replacement requires a workspace directory");
  }
  const canonicalWorkspaceDir = await fs.realpath(params.workspaceDir);
  const workspaceRoot = await root(canonicalWorkspaceDir);
  // resolveSafeMarkdownPath captures existing files' real paths before this
  // function starts. Keep that captured path; resolving it again here would
  // follow a pathname that may have been swapped after the containment check.
  const canonicalFilePath = params.expectedRealPath ?? params.filePath;
  if (!isPathInside(canonicalWorkspaceDir, canonicalFilePath)) {
    throw new Error("Refusing to stream a managed Markdown file outside the workspace");
  }
  const relativeTargetPath = path.relative(canonicalWorkspaceDir, canonicalFilePath);
  if (
    !relativeTargetPath ||
    relativeTargetPath === "." ||
    relativeTargetPath === ".." ||
    relativeTargetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTargetPath)
  ) {
    throw new Error("Refusing to stream a managed Markdown file outside the workspace");
  }
  const relativeTargetPathForRoot = relativeTargetPath.split(path.sep).join(path.posix.sep);
  const tempDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), `${params.tempPrefix}-`),
  );
  const tempPath = path.join(tempDir, path.basename(canonicalFilePath));
  let input: FileHandle | undefined;
  let output: FileHandle | undefined;
  const withheldPath = path.join(tempDir, `${path.basename(canonicalFilePath)}.withheld`);
  let withheldFile: FileHandle | undefined;
  const describeError = (error: unknown): string => {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return JSON.stringify(error) ?? "unknown error";
  };
  const cleanupTempDir = async (originalError?: unknown): Promise<void> => {
    try {
      await fs.rm(tempDir, { force: true, recursive: true });
    } catch (cleanupError) {
      if (originalError !== undefined) {
        throw new Error(
          `Streaming managed Markdown replacement failed (${describeError(originalError)}); ` +
            `temporary directory cleanup also failed (${describeError(cleanupError)})`,
          { cause: cleanupError },
        );
      }
      throw cleanupError;
    }
  };
  try {
    const opened = await openLocalFileSafely({ filePath: canonicalFilePath });
    input = opened.handle;
    if (opened.realPath !== canonicalFilePath) {
      throw new Error("Managed Markdown source path changed during streaming setup");
    }
    const inputSize = opened.stat.size;
    const mode = opened.stat.mode & 0o777;
    output = await fs.open(tempPath, "wx", mode);
    await output.chmod(mode);
    const managedBlock = buildManagedMarkdownBlock(params);
    // Mirror the shared SDK heading separator contract: one or more
    // whitespace-and-line-ending groups (including whitespace-only blank
    // lines) may separate the heading from the start marker.
    const headingSuffixPattern = new RegExp(
      `${params.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[ \t]*(?:\r\n|\n|\r))+[ \t]*$`,
    );
    const rollingWindowBytes =
      Math.max(params.heading.length + params.startMarker.length, params.endMarker.length) + 4096;
    let pending = "";
    let skipping = false;
    let wroteManagedBlock = false;
    let withholdingHeadingSeparator = false;
    let withheldHeadingHasLineEnding = false;
    let wroteAnyContent = false;
    let outputBytes = 0;
    let outputEndsWithLf = false;
    let lastNonWhitespaceEndBytes = 0;
    let withheldBytes = 0;
    let duplicateGapStartBytes: number | undefined;
    let duplicateGapStartEndsWithLf = false;
    let duplicateGapIsWhitespace = true;
    let shouldDropDuplicateGap = false;

    const isLineWhitespace = (value: string): boolean => /^[\t \r\n]*$/.test(value);

    const writeAll = async (
      handle: FileHandle,
      buffer: Buffer,
      position: number,
      label: string,
    ): Promise<void> => {
      let written = 0;
      while (written < buffer.byteLength) {
        const { bytesWritten } = await handle.write(
          buffer,
          written,
          buffer.byteLength - written,
          position + written,
        );
        if (
          !Number.isInteger(bytesWritten) ||
          bytesWritten <= 0 ||
          bytesWritten > buffer.byteLength - written
        ) {
          throw new Error(`${label} write made invalid progress at byte ${position + written}`);
        }
        written += bytesWritten;
      }
    };

    // Keep only a rolling marker window in memory. A malformed start marker
    // without an end marker is spooled so the original file can be replayed.
    const writeChunk = async (chunk: string): Promise<void> => {
      if (chunk.length > 0) {
        if (!output) {
          throw new Error("Streaming managed Markdown output is not open");
        }
        const buffer = Buffer.from(chunk, "utf-8");
        await writeAll(output, buffer, outputBytes, "Streaming managed Markdown output");
        if (duplicateGapStartBytes !== undefined && !isLineWhitespace(chunk)) {
          duplicateGapIsWhitespace = false;
        }
        const trimmed = chunk.trimEnd();
        if (trimmed.length > 0) {
          lastNonWhitespaceEndBytes = outputBytes + Buffer.byteLength(trimmed);
        }
        outputBytes += Buffer.byteLength(chunk);
        outputEndsWithLf = chunk.endsWith("\n");
        wroteAnyContent = true;
      }
    };
    const writeWithheld = async (chunk: string): Promise<void> => {
      if (chunk.length === 0) {
        return;
      }
      withheldFile ??= await fs.open(withheldPath, "w");
      const buffer = Buffer.from(chunk, "utf-8");
      await writeAll(withheldFile, buffer, withheldBytes, "Withheld managed Markdown output");
      withheldBytes += buffer.byteLength;
    };
    const clearWithheld = async (): Promise<void> => {
      await withheldFile?.close();
      withheldFile = undefined;
      await fs.rm(withheldPath, { force: true });
      withheldBytes = 0;
    };
    const replayWithheld = async (): Promise<void> => {
      await withheldFile?.close();
      withheldFile = undefined;
      try {
        for await (const chunk of createReadStream(withheldPath, { encoding: "utf-8" })) {
          await writeChunk(chunk);
        }
      } catch (err) {
        // SAFETY: replay only suppresses a missing optional withheld spool.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
      await fs.rm(withheldPath, { force: true });
      withheldBytes = 0;
    };
    const writeManagedBlock = async (): Promise<void> => {
      await writeChunk(managedBlock);
      duplicateGapStartBytes = outputBytes;
      duplicateGapStartEndsWithLf = outputEndsWithLf;
      duplicateGapIsWhitespace = true;
      wroteManagedBlock = true;
    };
    const completeManagedBlock = async (): Promise<void> => {
      if (!wroteManagedBlock) {
        await writeManagedBlock();
        return;
      }
      if (shouldDropDuplicateGap && duplicateGapStartBytes !== undefined) {
        await output?.truncate(duplicateGapStartBytes);
        outputBytes = duplicateGapStartBytes;
        outputEndsWithLf = duplicateGapStartEndsWithLf;
        lastNonWhitespaceEndBytes = Math.min(lastNonWhitespaceEndBytes, outputBytes);
      }
      duplicateGapStartBytes = outputBytes;
      duplicateGapStartEndsWithLf = outputEndsWithLf;
      duplicateGapIsWhitespace = true;
      shouldDropDuplicateGap = false;
    };

    const inputStream =
      inputSize > 0
        ? input.createReadStream({
            encoding: "utf-8",
            autoClose: false,
            start: 0,
            end: inputSize - 1,
          })
        : [];
    for await (const chunk of inputStream) {
      let current = pending + chunk;
      pending = "";
      while (current.length > 0) {
        if (skipping) {
          const endIndex = current.indexOf(params.endMarker);
          if (endIndex < 0) {
            const keep = preserveCodePointBoundary(
              current,
              Math.max(0, current.length - (params.endMarker.length - 1)),
            );
            await writeWithheld(current.slice(0, keep));
            pending = current.slice(keep);
            current = "";
            continue;
          }
          const afterEndIndex = endIndex + params.endMarker.length;
          await completeManagedBlock();
          await clearWithheld();
          skipping = false;
          current = current.slice(afterEndIndex);
          continue;
        }

        if (withholdingHeadingSeparator) {
          const separatorEnd = current.search(/[^\t \r\n]/);
          const separator = separatorEnd < 0 ? current : current.slice(0, separatorEnd);
          if (separator.length > 0) {
            await writeWithheld(separator);
            withheldHeadingHasLineEnding ||= /[\r\n]/.test(separator);
            current = current.slice(separator.length);
          }
          if (current.length === 0) {
            continue;
          }
          if (!withheldHeadingHasLineEnding) {
            await replayWithheld();
            withholdingHeadingSeparator = false;
            continue;
          }
          if (current.startsWith(params.startMarker)) {
            await writeWithheld(params.startMarker);
            shouldDropDuplicateGap = wroteManagedBlock && duplicateGapIsWhitespace;
            withholdingHeadingSeparator = false;
            skipping = true;
            current = current.slice(params.startMarker.length);
            continue;
          }
          if (params.startMarker.startsWith(current)) {
            pending = current;
            current = "";
            continue;
          }
          await replayWithheld();
          withholdingHeadingSeparator = false;
          continue;
        }

        const startIndex = current.indexOf(params.startMarker);
        if (startIndex < 0) {
          const headingIndex = current.lastIndexOf(params.heading);
          if (headingIndex >= 0) {
            const headingSuffix = current.slice(headingIndex + params.heading.length);
            if (isLineWhitespace(headingSuffix)) {
              await writeChunk(current.slice(0, headingIndex));
              await writeWithheld(current.slice(headingIndex));
              withholdingHeadingSeparator = true;
              withheldHeadingHasLineEnding = /[\r\n]/.test(headingSuffix);
              current = "";
              continue;
            }
          }
          const keep = preserveCodePointBoundary(
            current,
            Math.max(0, current.length - rollingWindowBytes),
          );
          await writeChunk(current.slice(0, keep));
          pending = current.slice(keep);
          current = "";
          continue;
        }

        const prefix = current.slice(0, startIndex);
        if (!headingSuffixPattern.test(prefix)) {
          // The shared SDK helper only replaces a managed block when the
          // configured heading directly precedes the start marker. A bare
          // marker pair is user content, so stream it through verbatim and
          // keep scanning for a heading-anchored block.
          const bareEnd = startIndex + params.startMarker.length;
          await writeChunk(current.slice(0, bareEnd));
          current = current.slice(bareEnd);
          continue;
        }
        const trimmedPrefix = prefix.replace(headingSuffixPattern, "");
        await writeChunk(trimmedPrefix);
        await writeWithheld(prefix.slice(trimmedPrefix.length));
        await writeWithheld(params.startMarker);
        shouldDropDuplicateGap = wroteManagedBlock && duplicateGapIsWhitespace;
        skipping = true;
        current = current.slice(startIndex + params.startMarker.length);
      }
    }
    await input.close();
    input = undefined;
    if (withholdingHeadingSeparator) {
      await replayWithheld();
    }
    if (skipping) {
      await replayWithheld();
      await writeChunk(pending);
      pending = "";
    }
    await writeChunk(pending);
    if (!wroteManagedBlock) {
      await output.truncate(lastNonWhitespaceEndBytes);
      outputBytes = lastNonWhitespaceEndBytes;
      outputEndsWithLf = false;
      const separator = wroteAnyContent && lastNonWhitespaceEndBytes > 0 ? "\n\n" : "";
      await writeChunk(`${separator}${managedBlock}\n`);
    } else if (!outputEndsWithLf) {
      await writeChunk("\n");
    }
    await output.sync();
    await output.close();
    output = undefined;
    // Commit through the root-relative writer. It pins traversal beneath the
    // checked workspace root and keeps a parent-directory swap from turning
    // the final write into an external pathname operation.
    await workspaceRoot.copyIn(relativeTargetPathForRoot, tempPath, {
      mode,
      mkdir: false,
      sourceHardlinks: "reject",
    });
  } catch (err) {
    await input?.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
    await withheldFile?.close().catch(() => undefined);
    await cleanupTempDir(err);
    throw err;
  }
  await cleanupTempDir();
}

export async function updateManagedDreamingMarkdownFile(
  params: ManagedMarkdownUpdateParams,
): Promise<void> {
  await fs.mkdir(path.dirname(params.filePath), { recursive: true });
  // Daily memory files historically followed user-managed symlinks. Resolve
  // those links before atomic replacement so the link itself stays intact.
  const resolved = await resolveSafeMarkdownPath(
    params.filePath,
    params.allowSymlink === true,
    params.workspaceDir,
  );
  const resolvedParams = {
    ...params,
    filePath: resolved?.filePath ?? params.filePath,
    expectedRealPath: resolved?.realPath,
  };
  const stat = resolved?.stat ?? null;
  if (!stat || stat.size <= MEMORY_DREAMING_MARKDOWN_MAX_BYTES) {
    let original = "";
    if (stat) {
      original = (
        await readRegularFile({
          filePath: resolvedParams.filePath,
          maxBytes: MEMORY_DREAMING_MARKDOWN_MAX_BYTES,
        })
      ).buffer.toString("utf-8");
    }
    const updated = replaceManagedMarkdownBlock({ original, ...resolvedParams });
    await replaceFileAtomic({
      filePath: resolvedParams.filePath,
      content: withTrailingNewline(updated),
      mode: resolvedParams.creationMode ?? 0o600,
      preserveExistingMode: true,
      tempPrefix: resolvedParams.tempPrefix,
      syncTempFile: true,
      syncParentDir: true,
      throwOnCleanupError: true,
    });
    return;
  }
  await replaceManagedMarkdownBlockStreaming(resolvedParams);
}

async function withDreamsFileLock<T>(
  workspaceDir: string,
  fn: (dreamsPath: string) => Promise<T>,
): Promise<T> {
  const dreamsPath = await resolveDreamsPath(workspaceDir);
  await fs.mkdir(path.dirname(dreamsPath), { recursive: true });
  let lockEntry = dreamsFileLocks.get(dreamsPath);
  if (!lockEntry) {
    lockEntry = { withLock: createAsyncLock(), refs: 0 };
    dreamsFileLocks.set(dreamsPath, lockEntry);
  }
  lockEntry.refs += 1;
  try {
    return await lockEntry.withLock(() => fn(dreamsPath));
  } finally {
    lockEntry.refs -= 1;
    if (lockEntry.refs <= 0 && dreamsFileLocks.get(dreamsPath) === lockEntry) {
      dreamsFileLocks.delete(dreamsPath);
    }
  }
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
  return await withMemoryWorkspaceLock(
    params.workspaceDir,
    async () =>
      await withDreamsFileLock(params.workspaceDir, async (dreamsPath) => {
        const existing = await readDreamsFile(dreamsPath);
        const { content, result, shouldWrite = true } = await params.updater(existing, dreamsPath);
        if (shouldWrite) {
          await writeDreamsFileAtomic(
            dreamsPath,
            content.endsWith("\n") ? content : `${content}\n`,
          );
        }
        return result;
      }),
  );
}

export async function updateDeepDreamsFile(params: {
  workspaceDir: string;
  bodyLines: string[];
}): Promise<string> {
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No durable changes.";
  return await withMemoryWorkspaceLock(
    params.workspaceDir,
    async () =>
      await withDreamsFileLock(params.workspaceDir, async (dreamsPath) => {
        await updateManagedDreamingMarkdownFile({
          filePath: dreamsPath,
          workspaceDir: params.workspaceDir,
          heading: "## Deep Sleep",
          startMarker: DEEP_START_MARKER,
          endMarker: DEEP_END_MARKER,
          body,
          tempPrefix: `${path.basename(dreamsPath)}.dreams`,
        });
        return dreamsPath;
      }),
  );
}
