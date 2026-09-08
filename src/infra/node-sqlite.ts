// Loads node:sqlite with OpenClaw warning handling.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "./errors.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);
let validatedSqliteModule: typeof import("node:sqlite") | undefined;
let extensionLoadingSupported = false;

type NodeSqliteDatabaseOptions = ConstructorParameters<
  typeof import("node:sqlite").DatabaseSync
>[1];

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

/** Build an immutable SQLite URI without losing the Windows long-path namespace. */
export function resolveImmutableSqliteFileUri(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const namespacedPath = path.win32.toNamespacedPath(path.win32.resolve(pathname));
    // SQLite decodes path escapes after separating the query string, so the
    // encoded \\?\ prefix reaches the Windows VFS without becoming URI syntax.
    return `file:${encodeURIComponent(namespacedPath)}?mode=ro&immutable=1`;
  }
  return `${pathToFileURL(path.resolve(pathname)).href}?mode=ro&immutable=1`;
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
    : "Upgrade to Node 24.16.0+ or 26.1.0+ before retrying.";
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
    const capabilities = database
      .prepare("SELECT sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted")
      .get();
    extensionLoadingSupported = capabilities?.omitted === 0;
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
    // Bun follow-up: Revalidate close/dispose file release after oven-sh/bun#40005 ships.
    // Bun 1.4.2 retains native statements after close; node:sqlite exposes no finalizer.
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

/** Whether the loaded SQLite library supports native extensions. */
export function supportsNodeSqliteExtensionLoading(): boolean {
  requireNodeSqlite();
  return extensionLoadingSupported;
}

/** Open node:sqlite through OpenClaw's runtime and filesystem-location boundary. */
export function openNodeSqliteDatabase(
  location: string,
  options?: NodeSqliteDatabaseOptions,
): import("node:sqlite").DatabaseSync {
  const sqlite = requireNodeSqlite();
  // Callers may pass file: URIs or already-namespaced paths from specialized
  // resolvers; location normalization must remain idempotent for those forms.
  const resolvedLocation = resolveNodeSqliteLocation(location);
  return options === undefined
    ? new sqlite.DatabaseSync(resolvedLocation)
    : new sqlite.DatabaseSync(resolvedLocation, options);
}

/** Compare versions only across reads on the same connection. */
export function readSqliteDataVersion(database: import("node:sqlite").DatabaseSync): number {
  // SAFETY: SQLite names this PRAGMA's column data_version; its numeric value is checked below.
  const row = database.prepare("PRAGMA data_version").get() as { data_version?: unknown };
  if (typeof row.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  return row.data_version;
}
