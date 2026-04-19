import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type SqliteVecModule = {
  getLoadablePath: () => string;
  load: (db: DatabaseSync) => void;
};

const SQLITE_VEC_MODULE_ID = "sqlite-vec";
let sqliteVecModulePromise: Promise<SqliteVecModule> | null = null;

async function loadSqliteVecModule(): Promise<SqliteVecModule> {
  sqliteVecModulePromise ??= import(SQLITE_VEC_MODULE_ID) as Promise<SqliteVecModule>;
  return sqliteVecModulePromise;
}

export async function loadSqliteVecExtension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    const sqliteVec = await loadSqliteVecModule();
    const resolvedPath = normalizeOptionalString(params.extensionPath);
    const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();

    params.db.enableLoadExtension(true);
    if (resolvedPath) {
      params.db.loadExtension(extensionPath);
    } else {
      sqliteVec.load(params.db);
    }

    return { ok: true, extensionPath };
  } catch (err) {
    const message = formatErrorMessage(err);
    return { ok: false, error: message };
  }
}
