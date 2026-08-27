// Exposes archive extraction helpers after applying fs-safe defaults.
import "./fs-safe-defaults.js";

export {
  extractArchiveWithRegularFileAliases as extractArchive,
  type ExtractArchiveWithRegularFileAliasesOptions as ExtractArchiveOptions,
} from "./archive-regular-file-aliases.js";

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
} from "@openclaw/fs-safe/archive";
