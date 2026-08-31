/** Public SDK subpath for bounded archive extraction and single-entry reads. */
export {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  extractArchive,
  readArchiveEntry,
  type ArchiveEntryKind,
  type ArchiveExtractLimits,
  type ExtractArchiveOptions,
} from "../infra/archive.js";
