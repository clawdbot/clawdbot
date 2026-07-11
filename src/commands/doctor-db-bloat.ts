// Doctor visibility for SQLite database bloat (state DB + per-agent DBs).
// Registered size_bytes existed for a while with no reader; production bloat
// (multi-hundred-MB stores, blocking vacuums) surfaced only after user harm.
import fs from "node:fs";
import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { formatBytes } from "./doctor-disk-space.js";

// Bloat is only worth an operator's attention when the file is meaningfully
// large AND a real share of it is reclaimable free pages.
const BLOAT_MIN_FILE_BYTES = 128 * 1024 * 1024;
const BLOAT_MIN_FREE_BYTES = 32 * 1024 * 1024;
const BLOAT_FREE_RATIO = 0.25;
const LARGE_DB_WARN_BYTES = 1024 * 1024 * 1024;

type SqliteBloatStats = {
  fileBytes: number;
  freeBytes: number;
  incrementalAutoVacuum: boolean;
};

function readSqliteBloatStats(pathname: string): SqliteBloatStats | null {
  // Diagnostics must degrade per-database: EACCES/ENOTDIR on a stale
  // registered path should skip that entry, not abort doctor.
  let fileBytes: number;
  try {
    fileBytes = fs.statSync(pathname, { throwIfNoEntry: false })?.size ?? 0;
  } catch {
    return null;
  }
  if (fileBytes <= 0) {
    return null;
  }
  const sqlite = requireNodeSqlite();
  let db: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    db = new sqlite.DatabaseSync(pathname, { readOnly: true });
    const pageSize = readPragmaNumber(db, "page_size") ?? 4096;
    const freelistCount = readPragmaNumber(db, "freelist_count") ?? 0;
    const autoVacuum = readPragmaNumber(db, "auto_vacuum") ?? 0;
    return {
      fileBytes,
      freeBytes: freelistCount * pageSize,
      incrementalAutoVacuum: autoVacuum === 2,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function readPragmaNumber(
  db: { prepare: (sql: string) => { get: () => unknown } },
  pragma: string,
): number | null {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function describeBloat(label: string, stats: SqliteBloatStats): string | null {
  const freeRatio = stats.fileBytes > 0 ? stats.freeBytes / stats.fileBytes : 0;
  const isBloated =
    stats.fileBytes >= BLOAT_MIN_FILE_BYTES &&
    stats.freeBytes >= BLOAT_MIN_FREE_BYTES &&
    freeRatio >= BLOAT_FREE_RATIO;
  if (isBloated) {
    const remedy = stats.incrementalAutoVacuum
      ? "incremental vacuum will release it gradually"
      : "run `VACUUM` offline (gateway stopped) to reclaim it";
    return `${label}: ${formatBytes(stats.fileBytes)} on disk with ${formatBytes(stats.freeBytes)} reclaimable free pages; ${remedy}.`;
  }
  if (stats.fileBytes >= LARGE_DB_WARN_BYTES) {
    return `${label}: ${formatBytes(stats.fileBytes)} on disk; review session/transcript retention settings if growth is unexpected.`;
  }
  return null;
}

export function collectSqliteBloatWarnings(deps?: { env?: NodeJS.ProcessEnv }): string[] {
  const env = deps?.env ?? process.env;
  const warnings: string[] = [];
  const statePath = resolveOpenClawStateSqlitePath(env);
  const stateStats = readSqliteBloatStats(statePath);
  if (stateStats) {
    const warning = describeBloat("state DB", stateStats);
    if (warning) {
      warnings.push(warning);
    }
  }
  for (const registered of listOpenClawRegisteredAgentDatabases({ env })) {
    const stats = readSqliteBloatStats(registered.path);
    if (!stats) {
      continue;
    }
    const warning = describeBloat(`agent DB (${registered.agentId})`, stats);
    if (warning) {
      warnings.push(warning);
    }
  }
  return warnings;
}

export function noteSqliteDatabaseBloat(
  _cfg: OpenClawConfig, // reserved for API consistency with other Doctor contributions
  deps?: { env?: NodeJS.ProcessEnv },
): void {
  const warnings = collectSqliteBloatWarnings(deps);
  if (warnings.length === 0) {
    return;
  }
  note(warnings.join("\n"), "SQLite database size");
}
