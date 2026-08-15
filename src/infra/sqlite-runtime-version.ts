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
