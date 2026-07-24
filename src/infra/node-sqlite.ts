// Loads node:sqlite with OpenClaw warning handling.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "./errors.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);
let validatedSqliteModule: typeof import("node:sqlite") | undefined;

export function resolveSqliteFilesystemPath(pathname: string): string {
  if (process.platform !== "win32") {
    return pathname;
  }
  // Node's fs APIs normalize long paths, but node:sqlite passes filesystem
  // names directly to SQLite's Windows VFS.
  return path.toNamespacedPath(path.resolve(pathname));
}

export function resolveNodeSqliteLocation(location: string): string {
  if (location === "" || location === ":memory:" || location.startsWith("file:")) {
    return location;
  }
  return resolveSqliteFilesystemPath(location);
}

export function resolveNodeSqliteReadOnlyLocation(
  pathname: string,
  hasWalSidecars: boolean,
): string {
  if (process.platform === "win32") {
    const resolvedPath = path.resolve(pathname);
    // SQLite URI authorities reject UNC hosts, while ordinary Windows paths
    // preserve UNC and already-namespaced locations through the Windows VFS.
    if (hasWalSidecars || resolvedPath.startsWith("\\\\")) {
      return path.toNamespacedPath(resolvedPath);
    }
    return `${pathToFileURL(resolvedPath).href}?mode=ro&immutable=1`;
  }
  if (hasWalSidecars) {
    return pathname;
  }
  return `${pathToFileURL(pathname).href}?mode=ro&immutable=1`;
}

function assertSqliteWalResetSafeVersion(version: string, nodeVersion: string): void {
  if (isSqliteWalResetSafeVersion(version)) {
    return;
  }
  const variables = (process.config as { variables?: Record<string, unknown> } | undefined)
    ?.variables;
  const isShared =
    variables?.node_shared_sqlite === true || variables?.node_shared_sqlite === "true";
  const wording = isShared ? "uses shared system" : "embeds";
  const remediation = isShared
    ? "Upgrade the system SQLite library to one of those safe versions, or use a Node build embedding a safe version."
    : "Upgrade to Node 22.22.3+, 24.15.0+, or 25.9.0+ before retrying.";
  throw new Error(
    `OpenClaw requires SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x for WAL safety; ` +
      `Node ${nodeVersion} ${wording} SQLite ${version}, which is affected by the upstream WAL-reset ` +
      `database corruption bug. ${remediation}`,
  );
}

function assertSafeSqliteRuntime(sqlite: typeof import("node:sqlite")): void {
  if (validatedSqliteModule === sqlite) {
    return;
  }
  // Shared-SQLite Node builds can load a different library than process.versions
  // reports, so query the loaded library before callers open real state databases.
  const database = new sqlite.DatabaseSync(":memory:");
  try {
    const row = database.prepare("SELECT sqlite_version() AS version").get() as
      | { version?: unknown }
      | undefined;
    const version = typeof row?.version === "string" ? row.version : "unknown";
    assertSqliteWalResetSafeVersion(version, process.versions.node);
    validatedSqliteModule = sqlite;
  } finally {
    database.close();
  }
}

// node:sqlite is optional across Node versions, so callers get a clear runtime
// error instead of a low-level module resolution failure.
/** Load node:sqlite after installing the process warning filter. */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
    assertSafeSqliteRuntime(sqlite);
    return sqlite;
  } catch (err) {
    const message = formatErrorMessage(err);
    throw new Error(`SQLite support is unavailable or unsafe in this Node runtime. ${message}`, {
      cause: err,
    });
  }
}
