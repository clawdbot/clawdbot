// Exposes archive extraction helpers after applying fs-safe defaults.
import "./fs-safe-defaults.js";
import {
  extractArchive as extractFsSafeArchive,
  type ArchiveExtractLimits,
  type ArchiveKind,
  type ArchiveLogger,
} from "@openclaw/fs-safe/archive";

// Archive extraction facade for size limits, staged writes, and traversal checks.
export {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
  createTarEntryPreflightChecker,
  loadZipArchiveWithPreflight,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  resolveArchiveKind,
  resolvePackedRootDir,
  withStagedArchiveDestination,
  type ArchiveLogger,
} from "@openclaw/fs-safe/archive";

// Keep the shipped Plugin SDK setup-tools signature stable; richer 0.5 policy
// options remain core-only until the plugin archive contract is reviewed.
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
  await extractFsSafeArchive(params);
}
