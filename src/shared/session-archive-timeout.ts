/** Cloud workspace reconciliation may take several minutes before archive can commit. */
export const SESSION_ARCHIVE_REQUEST_TIMEOUT_MS = 10 * 60_000;
export const SESSION_ARCHIVE_REQUEST_OPTIONS = { timeoutMs: SESSION_ARCHIVE_REQUEST_TIMEOUT_MS };
