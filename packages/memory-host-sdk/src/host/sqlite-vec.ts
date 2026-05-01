import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";
import { normalizeOptionalString } from "./string-utils.js";

type SqliteVecModule = {
  getLoadablePath: () => string;
  load: (db: DatabaseSync) => void;
};

const SQLITE_VEC_MODULE_ID = "sqlite-vec";

async function loadSqliteVecModule(): Promise<SqliteVecModule> {
  return import(SQLITE_VEC_MODULE_ID) as Promise<SqliteVecModule>;
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
    return { ok: false, error: message };
  }
}
