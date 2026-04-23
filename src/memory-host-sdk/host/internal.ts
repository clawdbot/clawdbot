import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { detectMime } from "../../media/mime.js";
import {
  CANONICAL_ROOT_MEMORY_FILENAME,
  resolveCanonicalRootMemoryFile,
  shouldSkipRootMemoryAuxiliaryPath,
} from "../../memory/root-memory-files.js";
import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../utils/cjk-chars.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { estimateStructuredEmbeddingInputBytes } from "./embedding-input-limits.js";
import { buildTextEmbeddingInput, type EmbeddingInput } from "./embedding-inputs.js";
import { isFileMissingError } from "./fs-utils.js";
import {
  buildMemoryMultimodalLabel,
  classifyMemoryMultimodalPath,
  type MemoryMultimodalModality,
  type MemoryMultimodalSettings,
} from "./multimodal.js";

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
  text: string;
  hash: string;
  embeddingInput?: EmbeddingInput;
};

export type MultimodalMemoryChunk = {
  chunk: MemoryChunk;
  structuredInputBytes: number;
};

const DISABLED_MULTIMODAL_SETTINGS: MemoryMultimodalSettings = {
  enabled: false,
  modalities: [],
  maxFileBytes: 0,
};

export function ensureDir(dir: string): string {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

export function normalizeRelPath(value: string): string {
  const trimmed = value.trim().replace(/^[./]+/, "");
  return trimmed.replace(/\\/g, "/");
}

export function normalizeExtraMemoryPaths(workspaceDir: string, extraPaths?: string[]): string[] {
  if (!extraPaths?.length) {
    return [];
  }
  const resolved = extraPaths
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value),
    );
  return Array.from(new Set(resolved));
}

export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  if (normalized === CANONICAL_ROOT_MEMORY_FILENAME || normalized === "DREAMS.md") {
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

async function walkDir(
  dir: string,
  files: string[],
  multimodal?: MemoryMultimodalSettings,
  shouldSkipPath?: (absPath: string) => boolean,
) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (shouldSkipPath?.(full)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === ".openclaw-repair") {
        continue;
      }
      await walkDir(full, files, multimodal, shouldSkipPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!isAllowedMemoryFilePath(full, multimodal)) {
      continue;
    }
    files.push(full);
  }
}

export async function listMemoryFiles(
  workspaceDir: string,
  extraPaths?: string[],
  multimodal?: MemoryMultimodalSettings,
): Promise<string[]> {
  const result: string[] = [];
  const memoryDir = path.join(workspaceDir, "memory");

  const shouldSkipWorkspaceMemoryPath = (absPath: string): boolean =>
    shouldSkipRootMemoryAuxiliaryPath({ workspaceDir, absPath });

  const addMarkdownFile = async (absPath: string) => {
    try {
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return;
      }
      if (!absPath.endsWith(".md")) {
        return;
      }
      result.push(absPath);
    } catch {}
  };

  const memoryFile = await resolveCanonicalRootMemoryFile(workspaceDir);
  if (memoryFile) {
    await addMarkdownFile(memoryFile);
  }
  try {
    const dirStat = await fs.lstat(memoryDir);
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      await walkDir(memoryDir, result, multimodal, shouldSkipWorkspaceMemoryPath);
    }
  } catch {}

  const normalizedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  if (normalizedExtraPaths.length > 0) {
    for (const inputPath of normalizedExtraPaths) {
      if (shouldSkipWorkspaceMemoryPath(inputPath)) {
        continue;
      }
      try {
        const stat = await fs.lstat(inputPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          await walkDir(inputPath, result, multimodal, shouldSkipWorkspaceMemoryPath);
          continue;
        }
        if (stat.isFile() && isAllowedMemoryFilePath(inputPath, multimodal)) {
          result.push(inputPath);
        }
      } catch {}
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

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
  multimodal?: MemoryMultimodalSettings,
): Promise<MemoryFileEntry | null> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
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
      buffer = await fs.readFile(absPath);
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
    content = await fs.readFile(absPath, "utf-8");
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
  let stat;
  try {
    stat = await fs.stat(entry.absPath);
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
  }
  if (stat.size !== entry.size) {
    return null;
  }
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(entry.absPath);
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

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number },
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

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      // First pass: slice at maxChars (preserves original behaviour for Latin).
      // Second pass: if a segment's *weighted* size still exceeds the budget
      // (happens for CJK-heavy text where 1 char ≈ 1 token), re-split it at
      // chunking.tokens so the chunk stays within the token budget.
      for (let start = 0; start < line.length; start += maxChars) {
        const coarse = line.slice(start, start + maxChars);
        if (estimateStringChars(coarse) > maxChars) {
          const fineStep = Math.max(1, chunking.tokens);
          for (let j = 0; j < coarse.length; ) {
            let end = Math.min(j + fineStep, coarse.length);
            // Avoid splitting inside a UTF-16 surrogate pair (CJK Extension B+).
            if (end < coarse.length) {
              const code = coarse.charCodeAt(end - 1);
              if (code >= 0xd800 && code <= 0xdbff) {
                end += 1; // include the low surrogate
              }
            }
            segments.push(coarse.slice(j, end));
            j = end; // advance cursor to the adjusted boundary
          }
        } else {
          segments.push(coarse);
        }
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

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const { results, firstError, hasError } = await runTasksWithConcurrency({
    tasks,
    limit,
    errorMode: "stop",
  });
  if (hasError) {
    throw firstError;
  }
  return results;
}
