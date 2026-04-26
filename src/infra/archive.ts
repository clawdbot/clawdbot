import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import * as tar from "tar";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-path.js";
import {
  createArchiveSymlinkTraversalError,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  prepareArchiveOutputPath,
  withStagedArchiveDestination,
} from "./archive-staging.js";
import { sameFileIdentity } from "./file-identity.js";
import { openFileWithinRoot, openWritableFileWithinRoot, SafeOpenError } from "./fs-safe.js";
import { isNotFoundPathError } from "./path-guards.js";

export type ArchiveKind = "tar" | "zip";

export type ArchiveLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ArchiveExtractLimits = {
  /**
   * Max archive file bytes (compressed).
   */
  maxArchiveBytes?: number;
  /** Max number of extracted entries (files + dirs). */
  maxEntries?: number;
  /** Max extracted bytes (sum of all files). */
  maxExtractedBytes?: number;
  /** Max extracted bytes for a single file entry. */
  maxEntryBytes?: number;
};

export { ArchiveSecurityError, type ArchiveSecurityErrorCode } from "./archive-staging.js";
export {
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  prepareArchiveOutputPath,
  withStagedArchiveDestination,
} from "./archive-staging.js";

/** @internal */
export const DEFAULT_MAX_ARCHIVE_BYTES_ZIP = 256 * 1024 * 1024;
/** @internal */
export const DEFAULT_MAX_ENTRIES = 50_000;
/** @internal */
export const DEFAULT_MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
/** @internal */
export const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;

export const ARCHIVE_LIMIT_ERROR_CODE = {
  ARCHIVE_SIZE_EXCEEDS_LIMIT: "archive-size-exceeds-limit",
  ENTRY_COUNT_EXCEEDS_LIMIT: "archive-entry-count-exceeds-limit",
  ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-entry-extracted-size-exceeds-limit",
  EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-extracted-size-exceeds-limit",
} as const;

export type ArchiveLimitErrorCode =
  (typeof ARCHIVE_LIMIT_ERROR_CODE)[keyof typeof ARCHIVE_LIMIT_ERROR_CODE];

const ARCHIVE_LIMIT_ERROR_MESSAGE = {
  [ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT]: "archive size exceeds limit",
  [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT]: "archive entry count exceeds limit",
  [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT]:
    "archive entry extracted size exceeds limit",
  [ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT]: "archive extracted size exceeds limit",
} as const satisfies Record<ArchiveLimitErrorCode, string>;

export class ArchiveLimitError extends Error {
  readonly code: ArchiveLimitErrorCode;

  constructor(code: ArchiveLimitErrorCode) {
    super(ARCHIVE_LIMIT_ERROR_MESSAGE[code]);
    this.name = "ArchiveLimitError";
    this.code = code;
  }
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_EOCD_MAX_COMMENT_BYTES = 0xffff;
const ZIP64_ENTRY_COUNT_SENTINEL = 0xffff;
const ZIP64_UINT32_SENTINEL = 0xffffffff;
const ZIP_CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const ZIP_CENTRAL_FILE_HEADER_MIN_BYTES = 46;
const ZIP_CENTRAL_FILE_HEADER_NAME_LENGTH_OFFSET = 28;
const ZIP_CENTRAL_FILE_HEADER_EXTRA_LENGTH_OFFSET = 30;
const ZIP_CENTRAL_FILE_HEADER_COMMENT_LENGTH_OFFSET = 32;
const ZIP_EOCD_TOTAL_ENTRIES_OFFSET = 10;
const ZIP_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET = 12;
const ZIP_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET = 16;
const ZIP_EOCD_COMMENT_LENGTH_OFFSET = 20;
const ZIP64_EOCD_LOCATOR_BYTES = 20;
const ZIP64_EOCD_OFFSET_OFFSET = 8;
const ZIP64_EOCD_TOTAL_ENTRIES_OFFSET = 32;
const ZIP64_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET = 40;
const ZIP64_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET = 48;
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

const TAR_SUFFIXES = [".tgz", ".tar.gz", ".tar"];

export function resolveArchiveKind(filePath: string): ArchiveKind | null {
  const lower = normalizeLowercaseStringOrEmpty(filePath);
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return "tar";
  }
  return null;
}

type ResolvePackedRootDirOptions = {
  rootMarkers?: string[];
};

async function hasPackedRootMarker(extractDir: string, rootMarkers: string[]): Promise<boolean> {
  for (const marker of rootMarkers) {
    const trimmed = marker.trim();
    if (!trimmed) {
      continue;
    }
    try {
      await fs.stat(path.join(extractDir, trimmed));
      return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export async function resolvePackedRootDir(
  extractDir: string,
  options?: ResolvePackedRootDirOptions,
): Promise<string> {
  const direct = path.join(extractDir, "package");
  try {
    const stat = await fs.stat(direct);
    if (stat.isDirectory()) {
      return direct;
    }
  } catch {
    // ignore
  }

  if ((options?.rootMarkers?.length ?? 0) > 0) {
    const hasMarker = await hasPackedRootMarker(extractDir, options?.rootMarkers ?? []);
    if (hasMarker) {
      return extractDir;
    }
  }

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (dirs.length !== 1) {
    throw new Error(`unexpected archive layout (dirs: ${dirs.join(", ")})`);
  }
  const onlyDir = dirs[0];
  if (!onlyDir) {
    throw new Error("unexpected archive layout (no package dir found)");
  }
  return path.join(extractDir, onlyDir);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

type ResolvedArchiveExtractLimits = Required<ArchiveExtractLimits>;

function clampLimit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const v = Math.floor(value);
  return v > 0 ? v : undefined;
}

function resolveExtractLimits(limits?: ArchiveExtractLimits): ResolvedArchiveExtractLimits {
  // Defaults: defensive, but should not break normal installs.
  return {
    maxArchiveBytes: clampLimit(limits?.maxArchiveBytes) ?? DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
    maxEntries: clampLimit(limits?.maxEntries) ?? DEFAULT_MAX_ENTRIES,
    maxExtractedBytes: clampLimit(limits?.maxExtractedBytes) ?? DEFAULT_MAX_EXTRACTED_BYTES,
    maxEntryBytes: clampLimit(limits?.maxEntryBytes) ?? DEFAULT_MAX_ENTRY_BYTES,
  };
}

function assertArchiveEntryCountWithinLimit(
  entryCount: number,
  limits: ResolvedArchiveExtractLimits,
) {
  if (entryCount > limits.maxEntries) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT);
  }
}

function asBufferView(buffer: Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(buffer)) {
    return buffer;
  }
  return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function readSafeUInt64LE(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(value);
}

function findZipEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.byteLength < ZIP_EOCD_MIN_BYTES) {
    return -1;
  }
  const minOffset = Math.max(
    0,
    buffer.byteLength - ZIP_EOCD_MIN_BYTES - ZIP_EOCD_MAX_COMMENT_BYTES,
  );
  for (let offset = buffer.byteLength - ZIP_EOCD_MIN_BYTES; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(offset + ZIP_EOCD_COMMENT_LENGTH_OFFSET);
    if (offset + ZIP_EOCD_MIN_BYTES + commentLength === buffer.byteLength) {
      return offset;
    }
  }
  return -1;
}

type ZipCentralDirectoryInfo = {
  declaredEntryCount: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  endOfCentralDirectoryOffset: number;
};

function readZip64CentralDirectoryInfo(
  buffer: Buffer,
  eocdOffset: number,
): ZipCentralDirectoryInfo | null {
  const locatorOffset = eocdOffset - ZIP64_EOCD_LOCATOR_BYTES;
  if (locatorOffset < 0 || buffer.readUInt32LE(locatorOffset) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
    return null;
  }
  const zip64EocdOffset = readSafeUInt64LE(buffer, locatorOffset + ZIP64_EOCD_OFFSET_OFFSET);
  if (
    zip64EocdOffset < 0 ||
    zip64EocdOffset + ZIP64_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET + 8 > buffer.byteLength ||
    buffer.readUInt32LE(zip64EocdOffset) !== ZIP64_EOCD_SIGNATURE
  ) {
    return null;
  }
  return {
    declaredEntryCount: readSafeUInt64LE(buffer, zip64EocdOffset + ZIP64_EOCD_TOTAL_ENTRIES_OFFSET),
    centralDirectorySize: readSafeUInt64LE(
      buffer,
      zip64EocdOffset + ZIP64_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET,
    ),
    centralDirectoryOffset: readSafeUInt64LE(
      buffer,
      zip64EocdOffset + ZIP64_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET,
    ),
    endOfCentralDirectoryOffset: eocdOffset,
  };
}

function readZipCentralDirectoryInfo(buffer: Buffer): ZipCentralDirectoryInfo | null {
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    return null;
  }
  const declaredEntryCount = buffer.readUInt16LE(eocdOffset + ZIP_EOCD_TOTAL_ENTRIES_OFFSET);
  const centralDirectorySize = buffer.readUInt32LE(
    eocdOffset + ZIP_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET,
  );
  const centralDirectoryOffset = buffer.readUInt32LE(
    eocdOffset + ZIP_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET,
  );
  const usesZip64 =
    declaredEntryCount === ZIP64_ENTRY_COUNT_SENTINEL ||
    centralDirectorySize === ZIP64_UINT32_SENTINEL ||
    centralDirectoryOffset === ZIP64_UINT32_SENTINEL;
  if (usesZip64) {
    return (
      readZip64CentralDirectoryInfo(buffer, eocdOffset) ?? {
        declaredEntryCount,
        centralDirectoryOffset,
        centralDirectorySize,
        endOfCentralDirectoryOffset: eocdOffset,
      }
    );
  }
  return {
    declaredEntryCount,
    centralDirectoryOffset,
    centralDirectorySize,
    endOfCentralDirectoryOffset: eocdOffset,
  };
}

function countZipCentralDirectoryHeaders(
  buffer: Buffer,
  info: ZipCentralDirectoryInfo,
): number | null {
  const start = info.centralDirectoryOffset;
  const declaredEnd = start + info.centralDirectorySize;
  const scanEnd = info.endOfCentralDirectoryOffset;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(declaredEnd) ||
    !Number.isSafeInteger(scanEnd) ||
    start < 0 ||
    declaredEnd < start ||
    scanEnd < start ||
    scanEnd > buffer.byteLength
  ) {
    return null;
  }
  let offset = start;
  let count = 0;
  while (offset < scanEnd) {
    if (scanEnd - offset < ZIP_CENTRAL_FILE_HEADER_MIN_BYTES) {
      break;
    }
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER_SIGNATURE) {
      break;
    }
    const nameLength = buffer.readUInt16LE(offset + ZIP_CENTRAL_FILE_HEADER_NAME_LENGTH_OFFSET);
    const extraLength = buffer.readUInt16LE(offset + ZIP_CENTRAL_FILE_HEADER_EXTRA_LENGTH_OFFSET);
    const commentLength = buffer.readUInt16LE(
      offset + ZIP_CENTRAL_FILE_HEADER_COMMENT_LENGTH_OFFSET,
    );
    const nextOffset =
      offset + ZIP_CENTRAL_FILE_HEADER_MIN_BYTES + nameLength + extraLength + commentLength;
    if (nextOffset <= offset || nextOffset > scanEnd) {
      return null;
    }
    count += 1;
    offset = nextOffset;
  }
  return count > 0 || info.declaredEntryCount === 0 ? count : null;
}

/** @internal */
export function readZipCentralDirectoryEntryCount(buffer: Buffer | Uint8Array): number | null {
  const view = asBufferView(buffer);
  const info = readZipCentralDirectoryInfo(view);
  if (!info) {
    return null;
  }
  const countedEntryCount = countZipCentralDirectoryHeaders(view, info);
  return countedEntryCount === null
    ? info.declaredEntryCount
    : Math.max(info.declaredEntryCount, countedEntryCount);
}

export async function loadZipArchiveWithPreflight(
  buffer: Buffer | Uint8Array,
  limits?: ArchiveExtractLimits,
): Promise<JSZip> {
  const resolvedLimits = resolveExtractLimits(limits);
  if (buffer.byteLength > resolvedLimits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }
  const entryCount = readZipCentralDirectoryEntryCount(buffer);
  if (entryCount !== null) {
    assertArchiveEntryCountWithinLimit(entryCount, resolvedLimits);
  }
  return await JSZip.loadAsync(buffer);
}

function createByteBudgetTracker(limits: ResolvedArchiveExtractLimits): {
  startEntry: () => void;
  addBytes: (bytes: number) => void;
  addEntrySize: (size: number) => void;
} {
  let entryBytes = 0;
  let extractedBytes = 0;

  const addBytes = (bytes: number) => {
    const b = Math.max(0, Math.floor(bytes));
    if (b === 0) {
      return;
    }
    entryBytes += b;
    if (entryBytes > limits.maxEntryBytes) {
      throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
    }
    extractedBytes += b;
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT);
    }
  };

  return {
    startEntry() {
      entryBytes = 0;
    },
    addBytes,
    addEntrySize(size: number) {
      const s = Math.max(0, Math.floor(size));
      if (s > limits.maxEntryBytes) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
      }
      // Note: tar budgets are based on the header-declared size.
      addBytes(s);
    },
  };
}

function createExtractBudgetTransform(params: {
  onChunkBytes: (bytes: number) => void;
}): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
        params.onChunkBytes(buf.byteLength);
        callback(null, buf);
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}

function symlinkTraversalError(originalPath: string) {
  return createArchiveSymlinkTraversalError(originalPath);
}

type OpenZipOutputFileResult = {
  handle: FileHandle;
  createdForWrite: boolean;
  openedRealPath: string;
  openedStat: Stats;
};

async function openZipOutputFile(params: {
  relPath: string;
  originalPath: string;
  destinationRealDir: string;
}): Promise<OpenZipOutputFileResult> {
  try {
    return await openWritableFileWithinRoot({
      rootDir: params.destinationRealDir,
      relativePath: params.relPath,
      mkdir: false,
      mode: 0o666,
    });
  } catch (err) {
    if (
      err instanceof SafeOpenError &&
      (err.code === "invalid-path" ||
        err.code === "outside-workspace" ||
        err.code === "path-mismatch")
    ) {
      throw symlinkTraversalError(params.originalPath);
    }
    throw err;
  }
}

async function cleanupPartialRegularFile(filePath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return;
    }
    throw err;
  }
  if (stat.isFile()) {
    await fs.unlink(filePath).catch(() => undefined);
  }
}

function buildArchiveAtomicTempPath(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function verifyZipWriteResult(params: {
  destinationRealDir: string;
  relPath: string;
  expectedStat: Stats;
}): Promise<string> {
  const opened = await openFileWithinRoot({
    rootDir: params.destinationRealDir,
    relativePath: params.relPath,
    rejectHardlinks: true,
  });
  try {
    if (!sameFileIdentity(opened.stat, params.expectedStat)) {
      throw new SafeOpenError("path-mismatch", "path changed during zip extract");
    }
    return opened.realPath;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

type ZipEntry = {
  name: string;
  dir: boolean;
  unixPermissions?: number;
  nodeStream?: () => NodeJS.ReadableStream;
  async: (type: "nodebuffer") => Promise<Buffer>;
};

type ZipExtractBudget = ReturnType<typeof createByteBudgetTracker>;

async function readZipEntryStream(entry: ZipEntry): Promise<NodeJS.ReadableStream> {
  if (typeof entry.nodeStream === "function") {
    return entry.nodeStream();
  }
  // Old JSZip: fall back to buffering, but still extract via a stream.
  const buf = await entry.async("nodebuffer");
  return Readable.from(buf);
}

function resolveZipOutputPath(params: {
  entryPath: string;
  strip: number;
  destinationDir: string;
}): { relPath: string; outPath: string } | null {
  validateArchiveEntryPath(params.entryPath);
  const relPath = stripArchivePath(params.entryPath, params.strip);
  if (!relPath) {
    return null;
  }
  validateArchiveEntryPath(relPath);
  return {
    relPath,
    outPath: resolveArchiveOutputPath({
      rootDir: params.destinationDir,
      relPath,
      originalPath: params.entryPath,
    }),
  };
}

async function prepareZipOutputPath(params: {
  destinationDir: string;
  destinationRealDir: string;
  relPath: string;
  outPath: string;
  originalPath: string;
  isDirectory: boolean;
}): Promise<void> {
  await prepareArchiveOutputPath(params);
}

async function writeZipFileEntry(params: {
  entry: ZipEntry;
  relPath: string;
  destinationRealDir: string;
  budget: ZipExtractBudget;
}): Promise<void> {
  const opened = await openZipOutputFile({
    relPath: params.relPath,
    originalPath: params.entry.name,
    destinationRealDir: params.destinationRealDir,
  });
  params.budget.startEntry();
  const readable = await readZipEntryStream(params.entry);
  const destinationPath = opened.openedRealPath;
  const targetMode = opened.openedStat.mode & 0o777;
  await opened.handle.close().catch(() => undefined);

  let tempHandle: FileHandle | null = null;
  let tempPath: string | null = null;
  let tempStat: Stats | null = null;
  let handleClosedByStream = false;

  try {
    tempPath = buildArchiveAtomicTempPath(destinationPath);
    tempHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, targetMode || 0o666);
    const writable = tempHandle.createWriteStream();
    writable.once("close", () => {
      handleClosedByStream = true;
    });

    await pipeline(
      readable,
      createExtractBudgetTransform({ onChunkBytes: params.budget.addBytes }),
      writable,
    );
    tempStat = await fs.stat(tempPath);
    if (!tempStat) {
      throw new Error("zip temp write did not produce file metadata");
    }
    if (!handleClosedByStream) {
      await tempHandle.close().catch(() => undefined);
      handleClosedByStream = true;
    }
    tempHandle = null;
    await fs.rename(tempPath, destinationPath);
    tempPath = null;
    const verifiedPath = await verifyZipWriteResult({
      destinationRealDir: params.destinationRealDir,
      relPath: params.relPath,
      expectedStat: tempStat,
    });

    // Best-effort permission restore for zip entries created on unix.
    if (typeof params.entry.unixPermissions === "number") {
      const mode = params.entry.unixPermissions & 0o777;
      if (mode !== 0) {
        await fs.chmod(verifiedPath, mode).catch(() => undefined);
      }
    }
  } catch (err) {
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    } else {
      await cleanupPartialRegularFile(destinationPath).catch(() => undefined);
    }
    if (err instanceof SafeOpenError) {
      throw symlinkTraversalError(params.entry.name);
    }
    throw err;
  } finally {
    if (tempHandle && !handleClosedByStream) {
      await tempHandle.close().catch(() => undefined);
    }
  }
}

async function extractZip(params: {
  archivePath: string;
  destDir: string;
  stripComponents?: number;
  limits?: ArchiveExtractLimits;
}): Promise<void> {
  const limits = resolveExtractLimits(params.limits);
  const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
  const stat = await fs.stat(params.archivePath);
  if (stat.size > limits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }

  const buffer = await fs.readFile(params.archivePath);
  const zip = await loadZipArchiveWithPreflight(buffer, limits);
  const entries = Object.values(zip.files) as ZipEntry[];
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));

  assertArchiveEntryCountWithinLimit(entries.length, limits);

  const budget = createByteBudgetTracker(limits);

  for (const entry of entries) {
    const output = resolveZipOutputPath({
      entryPath: entry.name,
      strip,
      destinationDir: params.destDir,
    });
    if (!output) {
      continue;
    }

    await prepareZipOutputPath({
      destinationDir: params.destDir,
      destinationRealDir,
      relPath: output.relPath,
      outPath: output.outPath,
      originalPath: entry.name,
      isDirectory: entry.dir,
    });
    if (entry.dir) {
      continue;
    }

    await writeZipFileEntry({
      entry,
      relPath: output.relPath,
      destinationRealDir,
      budget,
    });
  }
}

export type TarEntryInfo = { path: string; type: string; size: number };

const BLOCKED_TAR_ENTRY_TYPES = new Set([
  "SymbolicLink",
  "Link",
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
]);

function readTarEntryInfo(entry: unknown): TarEntryInfo {
  const p =
    typeof entry === "object" && entry !== null && "path" in entry
      ? String((entry as { path: unknown }).path)
      : "";
  const t =
    typeof entry === "object" && entry !== null && "type" in entry
      ? String((entry as { type: unknown }).type)
      : "";
  const s =
    typeof entry === "object" &&
    entry !== null &&
    "size" in entry &&
    typeof (entry as { size?: unknown }).size === "number" &&
    Number.isFinite((entry as { size: number }).size)
      ? Math.max(0, Math.floor((entry as { size: number }).size))
      : 0;
  return { path: p, type: t, size: s };
}

export function createTarEntryPreflightChecker(params: {
  rootDir: string;
  stripComponents?: number;
  limits?: ArchiveExtractLimits;
  escapeLabel?: string;
}): (entry: TarEntryInfo) => void {
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
  const limits = resolveExtractLimits(params.limits);
  let entryCount = 0;
  const budget = createByteBudgetTracker(limits);

  return (entry: TarEntryInfo) => {
    validateArchiveEntryPath(entry.path, { escapeLabel: params.escapeLabel });

    const relPath = stripArchivePath(entry.path, strip);
    if (!relPath) {
      return;
    }
    validateArchiveEntryPath(relPath, { escapeLabel: params.escapeLabel });
    resolveArchiveOutputPath({
      rootDir: params.rootDir,
      relPath,
      originalPath: entry.path,
      escapeLabel: params.escapeLabel,
    });

    if (BLOCKED_TAR_ENTRY_TYPES.has(entry.type)) {
      throw new Error(`tar entry is a link: ${entry.path}`);
    }

    entryCount += 1;
    assertArchiveEntryCountWithinLimit(entryCount, limits);
    budget.addEntrySize(entry.size);
  };
}

export async function extractArchive(params: {
  archivePath: string;
  destDir: string;
  timeoutMs: number;
  kind?: ArchiveKind;
  stripComponents?: number;
  tarGzip?: boolean;
  limits?: ArchiveExtractLimits;
  logger?: ArchiveLogger;
}): Promise<void> {
  const kind = params.kind ?? resolveArchiveKind(params.archivePath);
  if (!kind) {
    throw new Error(`unsupported archive: ${params.archivePath}`);
  }

  const label = kind === "zip" ? "extract zip" : "extract tar";
  if (kind === "tar") {
    await withTimeout(
      (async () => {
        const limits = resolveExtractLimits(params.limits);
        const stat = await fs.stat(params.archivePath);
        if (stat.size > limits.maxArchiveBytes) {
          throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
        }

        const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
        await withStagedArchiveDestination({
          destinationRealDir,
          run: async (stagingDir) => {
            const checkTarEntrySafety = createTarEntryPreflightChecker({
              rootDir: destinationRealDir,
              stripComponents: params.stripComponents,
              limits,
            });
            // A canonical cwd is not enough here: tar can still follow
            // pre-existing child symlinks in the live destination tree.
            // Extract into a private staging dir first, then merge through
            // the same safe-open boundary checks used by direct file writes.
            await tar.x({
              file: params.archivePath,
              cwd: stagingDir,
              strip: Math.max(0, Math.floor(params.stripComponents ?? 0)),
              gzip: params.tarGzip,
              preservePaths: false,
              strict: true,
              onReadEntry(entry) {
                try {
                  checkTarEntrySafety(readTarEntryInfo(entry));
                } catch (err) {
                  const error = err instanceof Error ? err : new Error(String(err));
                  // Node's EventEmitter calls listeners with `this` bound to the
                  // emitter (tar.Unpack), which exposes Parser.abort().
                  const emitter = this as unknown as { abort?: (error: Error) => void };
                  emitter.abort?.(error);
                }
              },
            });
            await mergeExtractedTreeIntoDestination({
              sourceDir: stagingDir,
              destinationDir: destinationRealDir,
              destinationRealDir,
            });
          },
        });
      })(),
      params.timeoutMs,
      label,
    );
    return;
  }

  await withTimeout(
    extractZip({
      archivePath: params.archivePath,
      destDir: params.destDir,
      stripComponents: params.stripComponents,
      limits: params.limits,
    }),
    params.timeoutMs,
    label,
  );
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}
