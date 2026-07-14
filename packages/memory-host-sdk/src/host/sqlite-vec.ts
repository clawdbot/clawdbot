// Memory Host SDK module implements sqlite vec behavior.
import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "./error-utils.js";
import { resolveSqliteVecPlatformVariant } from "./sqlite-vec-platform-variant.js";

type SqliteVecModule = {
  getLoadablePath: () => string;
  load: (db: DatabaseSync) => void;
};

const SQLITE_VEC_MODULE_ID = "sqlite-vec";
const SQLITE_VEC_CONFIG_HINT =
  "Set agents.defaults.memorySearch.store.vector.extensionPath, or an agent-specific memorySearch.store.vector.extensionPath, to a sqlite-vec loadable extension path.";

async function loadSqliteVecModule(): Promise<SqliteVecModule> {
  return import(SQLITE_VEC_MODULE_ID) as Promise<SqliteVecModule>;
}

function isMissingSqliteVecPackageError(err: unknown): boolean {
  const message = formatErrorMessage(err);
  const code =
    err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  const missingSqliteVec = /Cannot find (?:package|module) ['"]sqlite-vec['"]/u.test(message);
  return (
    missingSqliteVec &&
    (code === undefined || code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
  );
}

function assertSqliteVecAvailable(db: DatabaseSync, source: string): void {
  try {
    const row = db.prepare("SELECT vec_version() AS version").get() as
      | { version?: unknown }
      | undefined;
    if (typeof row?.version !== "string" || row.version.trim().length === 0) {
      throw new Error("vec_version() did not return a version");
    }
  } catch (err) {
    throw new Error(`sqlite-vec health check failed after loading ${source}`, { cause: err });
  }
}

function loadExtensionAndVerify(db: DatabaseSync, extensionPath: string): void {
  db.loadExtension(extensionPath);
  assertSqliteVecAvailable(db, extensionPath);
}

export async function loadSqliteVecExtension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    const resolvedPath = normalizeOptionalString(params.extensionPath);
    params.db.enableLoadExtension(true);
    if (resolvedPath) {
      loadExtensionAndVerify(params.db, resolvedPath);
      return { ok: true, extensionPath: resolvedPath };
    }

    try {
      const sqliteVec = await loadSqliteVecModule();
      const extensionPath = sqliteVec.getLoadablePath();
      sqliteVec.load(params.db);
      assertSqliteVecAvailable(params.db, extensionPath);
      return { ok: true, extensionPath };
    } catch (err) {
      // Optional-dep installs sometimes land only the platform-specific variant
      // (e.g. sqlite-vec-linux-x64) without the meta sqlite-vec package. Load
      // the loadable extension straight from the variant when we can find it.
      // Bundled runtimes can also fail the meta-package import while the native
      // variant is still present, so try the concrete extension before failing.
      const variant = resolveSqliteVecPlatformVariant();
      if (!variant) {
        if (!isMissingSqliteVecPackageError(err)) {
          throw err;
        }
        const message = formatErrorMessage(err);
        return {
          ok: false,
          error: `sqlite-vec package is not installed. ${SQLITE_VEC_CONFIG_HINT} Original error: ${message}`,
        };
      }
      try {
        loadExtensionAndVerify(params.db, variant.extensionPath);
        return { ok: true, extensionPath: variant.extensionPath };
      } catch (variantErr) {
        const message = formatErrorMessage(variantErr);
        if (!isMissingSqliteVecPackageError(err)) {
          const packageMessage = formatErrorMessage(err);
          return {
            ok: false,
            error: `sqlite-vec package failed to load, and platform variant ${variant.pkg} failed to load from ${variant.extensionPath}. ${SQLITE_VEC_CONFIG_HINT} Package error: ${packageMessage}. Variant error: ${message}`,
          };
        }
        return {
          ok: false,
          error: `sqlite-vec platform variant ${variant.pkg} failed to load from ${variant.extensionPath}. ${SQLITE_VEC_CONFIG_HINT} Original error: ${message}`,
        };
      }
    }
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}
