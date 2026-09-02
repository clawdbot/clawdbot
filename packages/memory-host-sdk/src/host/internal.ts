// Memory Host SDK module implements internal behavior.
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runWithConcurrency as runWithConcurrencyImpl } from "./concurrency.js";
import { MEMORY_HOST_ROOT_FILENAME, normalizeConfiguredMemoryExtraPaths } from "./config-utils.js";
import { estimateStructuredEmbeddingInputBytes } from "./embedding-input-limits.js";
import { buildTextEmbeddingInput, type EmbeddingInput } from "./embedding-inputs.js";
import { isExplicitExtraMarkdownFilePath } from "./explicit-extra-markdown.js";
import {
  isFileMissingError,
  readRegularFile,
  statRegularFile,
  walkDirectory,
  type WalkDirectoryEntry,
} from "./fs-utils.js";
import { hashText } from "./hash.js";
import {
  buildMemoryMultimodalLabel,
  classifyMemoryMultimodalPath,
  type MemoryMultimodalModality,
  type MemoryMultimodalSettings,
} from "./multimodal.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  detectMime,
  estimateStringChars,
  truncateUtf16Safe,
} from "./openclaw-runtime-io.js";
import {
  resolveCanonicalRootMemoryFile,
  shouldSkipRootMemoryAuxiliaryPath,
} from "./openclaw-runtime-memory.js";
import { retryTransientMemoryRead } from "./read-retry.js";
import type { MemoryEntryProvenance, MemoryExtraPath } from "./types.js";

export { hashText } from "./hash.js";

export type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  dataHash?: string;
  kind?: "markdown" | "multimodal";
  contentText?: string;
  modality?: MemoryMultimodalModality;
  mimeType?: string;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  entryStartLine?: number;
  entryEndLine?: number;
  text: string;
  hash: string;
  embeddingInput?: EmbeddingInput;
  provenance?: MemoryEntryProvenance;
};

// Persisted with index metadata so boundary changes rebuild unchanged files.
export const MEMORY_CHUNKING_VERSION = 3;

type MultimodalMemoryChunk = {
  chunk: MemoryChunk;
  structuredInputBytes: number;
};

const DISABLED_MULTIMODAL_SETTINGS: MemoryMultimodalSettings = {
  enabled: false,
  modalities: [],
  maxFileBytes: 0,
};

function ensureMemoryHostDir(dir: string): string {
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

export { ensureMemoryHostDir as ensureDir };

// File discovery skips non-regular entries. Keep the same rule when a listed
// file changes before its index entry is built, or one path can abort the sync.
async function statEnumerableMemoryFile(absPath: string): Promise<fsSync.Stats | null> {
  try {
    const stat = await fs.lstat(absPath);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }
    throw error;
  }
}

function normalizeRelPath(value: string): string {
  const trimmed = value.trim().replace(/^[./]+/, "");
  return trimmed.replace(/\\/g, "/");
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export type NormalizedExtraMemoryPath = { path: string; pattern?: string };

export function normalizeExtraMemoryPathEntries(
  workspaceDir: string,
  extraPaths?: MemoryExtraPath[],
): NormalizedExtraMemoryPath[] {
  return normalizeConfiguredMemoryExtraPaths(extraPaths).map((entry) => {
    const configuredPath = typeof entry === "string" ? entry : entry.path;
    const normalized: NormalizedExtraMemoryPath = {
      path: path.resolve(workspaceDir, expandHomePath(configuredPath)),
    };
    if (typeof entry !== "string") {
      normalized.pattern = entry.pattern?.replaceAll("\\", "/");
    }
    return normalized;
  });
}

export function normalizeExtraMemoryPaths(
  workspaceDir: string,
  extraPaths?: MemoryExtraPath[],
): string[] {
  return Array.from(
    new Set(normalizeExtraMemoryPathEntries(workspaceDir, extraPaths).map((entry) => entry.path)),
  );
}

export function matchesExtraMemoryPathEntry(
  entry: NormalizedExtraMemoryPath,
  candidatePath: string,
): boolean {
  if (!entry.pattern) {
    return true;
  }
  const relativePath = path.relative(entry.path, candidatePath);
  if (!relativePath) {
    return true;
  }
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }
  try {
    return path.posix.matchesGlob(relativePath.replaceAll(path.sep, "/"), entry.pattern);
  } catch {
    return false;
  }
}

export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  if (
    normalized === MEMORY_HOST_ROOT_FILENAME ||
    normalized === "USER.md" ||
    normalized.toLowerCase() === "dreams.md"
  ) {
    return true;
  }
  return normalized.startsWith("memory/");
}

function isAllowedMemoryFilePath(filePath: string, multimodal?: MemoryMultimodalSettings): boolean {
  if (filePath.endsWith(".md")) {
    return true;
  }
  return (
    classifyMemoryMultimodalPath(filePath, multimodal ?? DISABLED_MULTIMODAL_SETTINGS) !== null
  );
}

function shouldDescendMemoryEntry(
  entry: WalkDirectoryEntry,
  shouldSkipPath?: (absPath: string) => boolean,
): boolean {
  if (shouldSkipPath?.(entry.path)) {
    return false;
  }
  return entry.kind === "directory" && entry.name !== ".openclaw-repair";
}

class MemorySourceScanError extends Error {
  readonly path: string;
  readonly code?: string;

  constructor(sourcePath: string, cause: unknown) {
    const code =
      cause !== null &&
      typeof cause === "object" &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : undefined;
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`memory source scan failed at ${sourcePath}${code ? ` (${code})` : ""}: ${detail}`, {
      cause,
    });
    this.name = "MemorySourceScanError";
    this.path = sourcePath;
    this.code = code;
  }
}

async function scanMemorySource<T>(sourcePath: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isFileMissingError(error) || error instanceof MemorySourceScanError) {
      throw error;
    }
    throw new MemorySourceScanError(sourcePath, error);
  }
}

async function collectMemoryFilesFromDir(
  dir: string,
  files: string[],
  multimodal?: MemoryMultimodalSettings,
  shouldSkipPath?: (absPath: string) => boolean,
  extraPathEntry?: NormalizedExtraMemoryPath,
): Promise<void> {
  const scan = await scanMemorySource(dir, () =>
    walkDirectory(dir, {
      symlinks: "skip",
      descend: (entry) => shouldDescendMemoryEntry(entry, shouldSkipPath),
      include: (entry) =>
        !shouldSkipPath?.(entry.path) &&
        entry.kind === "file" &&
        isAllowedMemoryFilePath(entry.path, multimodal) &&
        (!extraPathEntry || matchesExtraMemoryPathEntry(extraPathEntry, entry.path)),
    }),
  );
  const operationalFailure = scan.failedDirs.find((failure) => !isFileMissingError(failure.error));
  if (operationalFailure) {
    throw new MemorySourceScanError(operationalFailure.path, operationalFailure.error);
  }
  files.push(...scan.entries.map((entry) => entry.path));
}

export async function listMemoryFiles(
  workspaceDir: string,
  extraPaths?: MemoryExtraPath[],
  multimodal?: MemoryMultimodalSettings,
): Promise<string[]> {
  const result: string[] = [];
  const memoryDir = path.join(workspaceDir, "memory");

  const shouldSkipWorkspaceMemoryPath = (absPath: string): boolean =>
    shouldSkipRootMemoryAuxiliaryPath({ workspaceDir, absPath });

  const addMarkdownFile = async (absPath: string) => {
    const stat = await scanMemorySource(absPath, () => statEnumerableMemoryFile(absPath));
    if (!stat || !absPath.endsWith(".md")) {
      return;
    }
    result.push(absPath);
  };

  const memoryFile = await scanMemorySource(workspaceDir, () =>
    resolveCanonicalRootMemoryFile(workspaceDir),
  );
  if (memoryFile) {
    await addMarkdownFile(memoryFile);
  }
  await addMarkdownFile(path.join(workspaceDir, "USER.md"));
  try {
    const dirStat = await scanMemorySource(memoryDir, () => fs.lstat(memoryDir));
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      // Default memory roots stay Markdown-only; multimodal discovery is an extraPaths opt-in.
      await collectMemoryFilesFromDir(memoryDir, result, undefined, shouldSkipWorkspaceMemoryPath);
    }
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
  }

  const normalizedExtraPaths = normalizeExtraMemoryPathEntries(workspaceDir, extraPaths);
  if (normalizedExtraPaths.length > 0) {
    for (const entry of normalizedExtraPaths) {
      const inputPath = entry.path;
      if (shouldSkipWorkspaceMemoryPath(inputPath)) {
        continue;
      }
      try {
        const stat = await scanMemorySource(inputPath, () => fs.lstat(inputPath));
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          await collectMemoryFilesFromDir(
            inputPath,
            result,
            multimodal,
            shouldSkipWorkspaceMemoryPath,
            entry,
          );
          continue;
        }
        if (
          stat.isFile() &&
          (isExplicitExtraMarkdownFilePath(inputPath) ||
            isAllowedMemoryFilePath(inputPath, multimodal))
        ) {
          result.push(inputPath);
        }
      } catch (error) {
        if (!isFileMissingError(error)) {
          throw error;
        }
      }
    }
  }
  if (result.length <= 1) {
    return result;
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of result) {
    let key = entry;
    try {
      key = await fs.realpath(entry);
    } catch {}
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
  multimodal?: MemoryMultimodalSettings,
): Promise<MemoryFileEntry | null> {
  const stat = await statEnumerableMemoryFile(absPath);
  if (!stat) {
    return null;
  }
  const normalizedPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
  const multimodalSettings = multimodal ?? DISABLED_MULTIMODAL_SETTINGS;
  const modality = classifyMemoryMultimodalPath(absPath, multimodalSettings);
  if (modality) {
    if (stat.size > multimodalSettings.maxFileBytes) {
      return null;
    }
    let buffer: Buffer;
    try {
      buffer = (
        await retryTransientMemoryRead(
          () =>
            readRegularFile({
              filePath: absPath,
              maxBytes: multimodalSettings.maxFileBytes,
            }),
          `read multimodal memory file ${absPath}`,
        )
      ).buffer;
    } catch (err) {
      if (isFileMissingError(err)) {
        return null;
      }
      throw err;
    }
    const mimeType = await detectMime({ buffer: buffer.subarray(0, 512), filePath: absPath });
    if (!mimeType || !mimeType.startsWith(`${modality}/`)) {
      return null;
    }
    const contentText = buildMemoryMultimodalLabel(modality, normalizedPath);
    const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const chunkHash = hashText(
      JSON.stringify({
        path: normalizedPath,
        contentText,
        mimeType,
        dataHash,
      }),
    );
    return {
      path: normalizedPath,
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: chunkHash,
      dataHash,
      kind: "multimodal",
      contentText,
      modality,
      mimeType,
    };
  }
  let content: string;
  try {
    content = (
      await retryTransientMemoryRead(
        () => readRegularFile({ filePath: absPath }),
        `read memory index file ${absPath}`,
      )
    ).buffer.toString("utf-8");
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
  }
  const hash = hashText(content);
  return {
    path: normalizedPath,
    absPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash,
    kind: "markdown",
  };
}

async function loadMultimodalEmbeddingInput(
  entry: Pick<
    MemoryFileEntry,
    "absPath" | "contentText" | "mimeType" | "kind" | "size" | "dataHash"
  >,
): Promise<EmbeddingInput | null> {
  if (entry.kind !== "multimodal" || !entry.contentText || !entry.mimeType) {
    return null;
  }
  const regularFile = await statRegularFile(entry.absPath);
  if (regularFile.missing) {
    return null;
  }
  const stat = regularFile.stat;
  if (stat.size !== entry.size) {
    return null;
  }
  let buffer: Buffer;
  try {
    buffer = (
      await retryTransientMemoryRead(
        () => readRegularFile({ filePath: entry.absPath, maxBytes: entry.size }),
        `read multimodal indexing file ${entry.absPath}`,
      )
    ).buffer;
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
  }
  const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (entry.dataHash && entry.dataHash !== dataHash) {
    return null;
  }
  return {
    text: entry.contentText,
    parts: [
      { type: "text", text: entry.contentText },
      {
        type: "inline-data",
        mimeType: entry.mimeType,
        data: buffer.toString("base64"),
      },
    ],
  };
}

export async function buildMultimodalChunkForIndexing(
  entry: Pick<
    MemoryFileEntry,
    "absPath" | "contentText" | "mimeType" | "kind" | "hash" | "size" | "dataHash"
  >,
): Promise<MultimodalMemoryChunk | null> {
  const embeddingInput = await loadMultimodalEmbeddingInput(entry);
  if (!embeddingInput) {
    return null;
  }
  return {
    chunk: {
      startLine: 1,
      endLine: 1,
      text: entry.contentText ?? embeddingInput.text,
      hash: entry.hash,
      embeddingInput,
    },
    structuredInputBytes: estimateStructuredEmbeddingInputBytes(embeddingInput),
  };
}

export type CuratedMarkdownEntry = {
  startLine: number;
  endLine: number;
  text: string;
  kind: "entry" | "section";
};
export {
  extractProjectKeysFromCuratedEntry,
  INVALID_PROJECT_ANNOTATION_KEY,
  normalizeProjectAnnotationKey,
  stripMemoryAnnotationCarriers,
  type CuratedProjectAnnotations,
} from "./curated-annotations.js";

export function splitCuratedMarkdownEntries(content: string): CuratedMarkdownEntry[] {
  const lines = content.split("\n");
  const entries: CuratedMarkdownEntry[] = [];
  let startIndex = 0;
  let kind: CuratedMarkdownEntry["kind"] = lines[0]?.startsWith("- ") ? "entry" : "section";
  const flush = (endIndex: number) => {
    if (endIndex < startIndex) {
      return;
    }
    entries.push({
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      text: lines.slice(startIndex, endIndex + 1).join("\n"),
      kind,
    });
  };
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextKind = line.startsWith("- ")
      ? "entry"
      : /^#{1,6}(?:\s|$)/u.test(line)
        ? "section"
        : undefined;
    if (!nextKind) {
      continue;
    }
    flush(index - 1);
    startIndex = index;
    kind = nextKind;
  }
  flush(lines.length - 1);
  return entries;
}

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number; perEntry?: boolean },
): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return [];
  }
  const maxChars = Math.max(32, chunking.tokens * CHARS_PER_TOKEN_ESTIMATE);
  const overlapChars = Math.max(0, chunking.overlap * CHARS_PER_TOKEN_ESTIMATE);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;
  let entryStartLine: number | undefined;
  let entryFirstChunk = 0;
  const curatedEntryStarts = chunking.perEntry
    ? new Map(splitCuratedMarkdownEntries(content).map((entry) => [entry.startLine, entry]))
    : undefined;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const firstEntry = current[0];
    const lastEntry = current[current.length - 1];
    if (!firstEntry || !lastEntry) {
      return;
    }
    const text = current.map((entry) => entry.line).join("\n");
    const startLine = firstEntry.lineNo;
    const endLine = lastEntry.lineNo;
    chunks.push({
      startLine,
      endLine,
      text,
      hash: hashText(text),
      embeddingInput: buildTextEmbeddingInput(text),
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) {
        continue;
      }
      acc += estimateStringChars(entry.line) + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) {
        break;
      }
    }
    current = kept;
    currentChars = acc;
  };

  const finishEntry = (entryEndLine: number) => {
    if (entryStartLine === undefined) {
      return;
    }
    // Every size fragment remains part of the same curated entry and inherits
    // its full annotation span; dropping scope on later fragments can leak them.
    for (const chunk of chunks.slice(entryFirstChunk)) {
      chunk.entryStartLine = entryStartLine;
      chunk.entryEndLine = entryEndLine;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const curatedEntry = curatedEntryStarts?.get(lineNo);
    if (curatedEntry) {
      if (current.length > 0) {
        flush();
      }
      finishEntry(lineNo - 1);
      current = [];
      currentChars = 0;
      entryStartLine = curatedEntry.kind === "entry" ? lineNo : undefined;
      entryFirstChunk = chunks.length;
    }
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      // First pass: slice at maxChars (preserves original behaviour for Latin).
      // Second pass: if a segment's *weighted* size still exceeds the budget
      // (happens for CJK-heavy text where 1 char ≈ 1 token), re-split it at
      // chunking.tokens so the chunk stays within the token budget.
      for (let start = 0; start < line.length;) {
        const coarse = truncateUtf16Safe(line.slice(start), maxChars);
        if (estimateStringChars(coarse) > maxChars) {
          const fineStep = Math.max(1, chunking.tokens);
          for (let j = 0; j < coarse.length;) {
            let end = Math.min(j + fineStep, coarse.length);
            const lastCodeUnit = coarse.charCodeAt(end - 1);
            if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && end < coarse.length) {
              end += 1;
            }
            segments.push(coarse.slice(j, end));
            j = end;
          }
        } else {
          segments.push(coarse);
        }
        start += coarse.length;
      }
    }
    for (const segment of segments) {
      const lineSize = estimateStringChars(segment) + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  finishEntry(lines.length);
  return chunks;
}

/**
 * Remap chunk startLine/endLine from content-relative positions to original
 * source file positions using a lineMap.  Each entry in lineMap gives the
 * 1-indexed source line for the corresponding 0-indexed content line.
 *
 * This is used for session JSONL files where buildSessionEntry() flattens
 * messages into a plain-text string before chunking.  Without remapping the
 * stored line numbers would reference positions in the flattened text rather
 * than the original JSONL file.
 */
export function remapChunkLines(chunks: MemoryChunk[], lineMap: number[] | undefined): void {
  if (!lineMap || lineMap.length === 0) {
    return;
  }
  for (const chunk of chunks) {
    // startLine/endLine are 1-indexed; lineMap is 0-indexed by content line
    chunk.startLine = lineMap[chunk.startLine - 1] ?? chunk.startLine;
    chunk.endLine = lineMap[chunk.endLine - 1] ?? chunk.endLine;
  }
}

export function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function runMemoryHostTasksWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  return runWithConcurrencyImpl(tasks, limit);
}

export { runMemoryHostTasksWithConcurrency as runWithConcurrency };
