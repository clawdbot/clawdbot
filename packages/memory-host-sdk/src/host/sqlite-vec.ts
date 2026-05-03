import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";
import { normalizeOptionalString } from "./string-utils.js";

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

export async function loadSqliteVecExtension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    const resolvedPath = normalizeOptionalString(params.extensionPath);
    params.db.enableLoadExtension(true);
    if (resolvedPath) {
      params.db.loadExtension(resolvedPath);
      return { ok: true, extensionPath: resolvedPath };
    }

    const sqliteVec = await loadSqliteVecModule();
    const extensionPath = sqliteVec.getLoadablePath();
    sqliteVec.load(params.db);
    return { ok: true, extensionPath };
  } catch (err) {
    const message = formatErrorMessage(err);
    if (isMissingSqliteVecPackageError(err)) {
      return {
        ok: false,
        error: `sqlite-vec package is not installed. ${SQLITE_VEC_CONFIG_HINT} Original error: ${message}`,
      };
    }
    return { ok: false, error: message };
  }
}
