export const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const DIR_FETCH_MAX_ENTRIES = 5000;

// One contract for archive admission on the node, Gateway policy, and extraction.
export const DIR_FETCH_ARCHIVE_LIMITS = {
  maxArchiveBytes: DIR_FETCH_HARD_MAX_BYTES,
  // Admission counts every TAR member, including the producer's root `./`
  // header; the descendant policy cap stays 5000 and does not charge the root.
  maxEntries: DIR_FETCH_MAX_ENTRIES + 1,
  maxExtractedBytes: 64 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
};
