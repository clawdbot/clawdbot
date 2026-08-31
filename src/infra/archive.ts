// Exposes archive extraction helpers after applying fs-safe defaults.
import "./fs-safe-defaults.js";

// Archive extraction facade for size limits, staged writes, and traversal checks.
export {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveFormatError,
  ArchiveLimitError,
  ArchiveSecurityError,
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
  createTarEntryPreflightChecker,
  extractArchive,
  loadZipArchiveWithPreflight,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  readArchiveEntry,
  resolveArchiveKind,
  resolvePackedRootDir,
  withStagedArchiveDestination,
  type ArchiveLogger,
  type ArchiveEntryKind,
  type ArchiveExtractLimits,
  type ExtractArchiveOptions,
} from "@openclaw/fs-safe/archive";
