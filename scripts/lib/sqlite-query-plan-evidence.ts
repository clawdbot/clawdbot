export type SqliteQueryPlanEvidence = {
  fullTableScans: string[];
  indexes: string[];
  raw: string[];
  tempSorts: string[];
};

const INDEX_PATTERN = /\bUSING ((?:(?:AUTOMATIC|PARTIAL|COVERING)\s+)*INDEX)(?:\s+([^\s(]+))?/iu;
const NON_TABLE_SCAN_PATTERN = /\b(?:CONSTANT ROW|SUBQUERY|VALUES CLAUSE|VIRTUAL TABLE INDEX)\b/iu;

export function collectSqliteQueryPlanEvidence(raw: string[]): SqliteQueryPlanEvidence {
  const indexes = [
    ...new Set(
      raw.flatMap((detail) => {
        const match = INDEX_PATTERN.exec(detail);
        return match?.[1] ? [match[2] ?? match[1]] : [];
      }),
    ),
  ];
  return {
    fullTableScans: raw.filter(
      (detail) =>
        /^\s*SCAN \S+/iu.test(detail) &&
        !/\bUSING\b/iu.test(detail) &&
        !NON_TABLE_SCAN_PATTERN.test(detail),
    ),
    indexes,
    raw,
    tempSorts: raw.filter((detail) => detail.includes("USE TEMP B-TREE")),
  };
}
