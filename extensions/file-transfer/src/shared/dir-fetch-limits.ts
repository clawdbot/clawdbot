export const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const DIR_FETCH_MAX_ENTRIES = 5000;

// One contract for archive admission on the node, Gateway policy, and extraction.
export const DIR_FETCH_ARCHIVE_LIMITS = {
  maxArchiveBytes: DIR_FETCH_HARD_MAX_BYTES,
  maxEntries: DIR_FETCH_MAX_ENTRIES,
  maxExtractedBytes: 64 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
};
