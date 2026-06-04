// Loads node:sqlite with OpenClaw warning handling.
import { createRequire } from "node:module";
import { formatErrorMessage } from "./errors.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);

// node:sqlite is optional across Node versions, so callers get a clear runtime
// error instead of a low-level module resolution failure.
/** Load node:sqlite after installing the process warning filter. */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = formatErrorMessage(err);
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}
