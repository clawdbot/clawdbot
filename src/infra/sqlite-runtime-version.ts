import { isRecord } from "@openclaw/normalization-core";

type SqliteVersion = {
  major: number;
  minor: number;
  patch: number;
};

const SQLITE_WAL_RESET_FIXED_VERSION: SqliteVersion = { major: 3, minor: 51, patch: 3 };
const SQLITE_WAL_RESET_BACKPORTS: readonly SqliteVersion[] = [
  { major: 3, minor: 44, patch: 6 },
  { major: 3, minor: 50, patch: 7 },
];
const SQLITE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;

/** Query the SQLite library loaded by the current runtime without opening persisted state. */
export function detectCurrentRuntimeSqliteVersion(): string | null {
  const sqlite = process.getBuiltinModule?.("node:sqlite");
  if (!sqlite?.DatabaseSync) {
    return null;
  }
  // This in-memory bootstrap probe intentionally stays in the lightweight runtime-version owner;
  // importing the persisted-state SQLite owner would pull logger packages into CLI startup.
  const database = new sqlite.DatabaseSync(":memory:");
  try {
    const row: unknown = database.prepare("SELECT sqlite_version() AS version").get();
    return isRecord(row) && typeof row.version === "string" ? row.version : null;
  } finally {
    database.close();
  }
}

function parseSqliteVersion(value: string): SqliteVersion | null {
  const match = SQLITE_VERSION_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }
  return { major, minor, patch };
}

function compareSqliteVersions(left: SqliteVersion, right: SqliteVersion): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

export function isSqliteWalResetSafeVersion(value: string): boolean {
  const version = parseSqliteVersion(value);
  if (!version) {
    return false;
  }
  if (compareSqliteVersions(version, SQLITE_WAL_RESET_FIXED_VERSION) >= 0) {
    return true;
  }
  return SQLITE_WAL_RESET_BACKPORTS.some(
    (backport) =>
      version.major === backport.major &&
      version.minor === backport.minor &&
      version.patch >= backport.patch,
  );
}
