// Plugin SDK file-lock surface re-exported for infra callers that should share
// the same durable lock semantics as plugins.
export type {
  FileLockHandle,
  FileLockOptions,
  FileLockTimeoutError,
} from "../plugin-sdk/file-lock.js";
export {
  acquireFileLock,
  drainFileLockStateForTest,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  resetFileLockStateForTest,
  withFileLock,
} from "../plugin-sdk/file-lock.js";
