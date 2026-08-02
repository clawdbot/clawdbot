/** Warning-only issues that must not prevent a recoverable SQLite migration from converging. */
export const SESSION_SQLITE_WARNING_ISSUE_CODES: ReadonlySet<string> = new Set([
  "entry_invalid",
  "entry_superseded",
  "transcript_missing",
  "transcript_archive_failed",
  "transcript_malformed",
  "unreferenced_jsonl_archive_failed",
]);
