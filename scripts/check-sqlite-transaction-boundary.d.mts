export type SqliteTransactionBoundaryViolation = {
  line: number;
  reason: string;
};

export function findSqliteTransactionBoundaryViolations(
  content: string,
  fileName?: string,
): SqliteTransactionBoundaryViolation[];
