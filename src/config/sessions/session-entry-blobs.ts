// The two largest fields on a session entry — a per-file/per-tool system-prompt
// breakdown and the full skills snapshot (incl. the skill prompt) — dominate
// `entry_json` byte size (~95% on real stores) yet are never needed by the
// session list. They are externalized into the `session_nodes.entry_blobs_json`
// side column so the hot bulk list read parses a small `entry_json`, and are
// hydrated back only on per-key / full-entry reads. See parseSqliteSessionEntryRecord
// (merge) and bindSqliteSessionNode (split).
export const SESSION_ENTRY_BLOB_FIELDS = ["systemPromptReport", "skillsSnapshot"] as const;

type SessionEntryBlobField = (typeof SESSION_ENTRY_BLOB_FIELDS)[number];

type MutableEntry = Record<string, unknown>;

/**
 * Split the two large blob fields out of a canonical entry.
 * Returns the entry without those fields plus a JSON string of just the blobs
 * (or null when neither field is present with a non-null value). Only present,
 * non-null values are moved, so a `"systemPromptReport": null` stays inline
 * harmlessly and matches the migration's `json_extract(...) IS NOT NULL` gate.
 */
export function splitSessionEntryBlobs<T extends MutableEntry>(
  entry: T,
): {
  entry: T;
  blobsJson: string | null;
} {
  const source = entry as MutableEntry;
  const blobs: MutableEntry = {};
  let hasBlob = false;
  for (const field of SESSION_ENTRY_BLOB_FIELDS) {
    const value = source[field];
    if (value !== undefined && value !== null) {
      blobs[field] = value;
      hasBlob = true;
    }
  }
  if (!hasBlob) {
    return { entry, blobsJson: null };
  }
  const stripped: MutableEntry = { ...source };
  for (const field of SESSION_ENTRY_BLOB_FIELDS) {
    delete stripped[field];
  }
  return { entry: stripped as T, blobsJson: JSON.stringify(blobs) };
}

/**
 * Merge externalized blobs back onto a parsed entry, in place. No-op when the
 * column is null/empty (list snapshot rows, or rows written before the side
 * column existed). Invalid JSON is dropped rather than throwing — the entry is
 * served without the blobs.
 */
export function mergeSessionEntryBlobs<T extends MutableEntry>(
  entry: T,
  entryBlobsJson: string | null | undefined,
): T {
  if (typeof entryBlobsJson !== "string" || entryBlobsJson.length === 0) {
    return entry;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(entryBlobsJson);
  } catch {
    return entry;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return entry;
  }
  const blobs = parsed as MutableEntry;
  const target = entry as MutableEntry;
  for (const field of SESSION_ENTRY_BLOB_FIELDS) {
    const value = blobs[field];
    if (value !== undefined && value !== null) {
      target[field satisfies SessionEntryBlobField] = value;
    }
  }
  return entry;
}
