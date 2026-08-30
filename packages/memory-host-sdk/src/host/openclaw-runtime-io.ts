// Narrow IO/runtime facade re-exported for memory host helpers.

export {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
export {
  configureSqliteConnectionPragmas,
  configureSqliteWalMaintenance,
} from "../../../../src/infra/sqlite-wal.js";
export type {
  SqliteConnectionPragmaOptions,
  SqliteWalMaintenance,
  SqliteWalMaintenanceOptions,
} from "../../../../src/infra/sqlite-wal.js";
export { root } from "../../../../src/infra/fs-safe.js";
export { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
export { detectMime } from "@openclaw/media-core/mime";
export { installProcessWarningFilter } from "../../../../src/infra/warning-filter.js";
export { redactSensitiveText } from "../../../../src/logging/redact.js";
export { resolveGlobalSingleton } from "../../../../src/shared/global-singleton.js";
export { runTasksWithConcurrency } from "../../../../src/utils/run-with-concurrency.js";
export { splitShellArgs } from "../../../../src/utils/shell-argv.js";
export {
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
  truncateUtf16Safe,
} from "../../../../src/utils.js";
