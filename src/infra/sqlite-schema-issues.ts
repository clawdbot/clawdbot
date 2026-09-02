export type SqliteSchemaIssueCode =
  | "column-definition-drift"
  | "missing-column"
  | "missing-or-drifted-index"
  | "missing-or-drifted-trigger"
  | "missing-table"
  | "table-constraint-drift"
  | "table-definition-drift"
  | "table-options-drift"
  | "unexpected-column"
  | "unexpected-trigger"
  | "unexpected-unique-index"
  | "virtual-table-definition-drift";

export type SqliteSchemaIssue = {
  code: SqliteSchemaIssueCode;
  message: string;
  objectName: string;
};

export type SqliteSchemaCompatibility = {
  /**
   * Canonical additive tables that may be absent until their owning feature
   * performs its one-time lazy ensure. Present tables still require the exact
   * canonical shape.
   */
  allowedMissingTables?: readonly string[];
  /** Same-version non-unique indexes that a writable cold open lazily repairs. */
  allowedMissingIndexes?: readonly string[];
  /** Additive columns that may be absent until their owning feature lazily ensures them. */
  allowedMissingColumns?: readonly string[];
  /**
   * Exact definitions produced by supported additive migrations when SQLite
   * requires a temporary default that the clean schema does not retain.
   */
  allowedColumnDefinitions?: Readonly<Record<string, readonly string[]>>;
  /**
   * Allow unexpected columns declared as a name plus one bare nullable SQLite
   * STRICT datatype. Allowed-missing tables remain exact when present.
   */
  allowCompatibleAdditiveColumns?: boolean;
  /**
   * Exact owner-defined trigger groups that may be absent when their derived
   * or lazily ensured schema is absent, but must be complete and canonical
   * when present.
   */
  optionalCanonicalTriggerGroups?: readonly {
    /** The trigger group is optional only while this canonical table is absent. */
    optionalWhenTableMissing?: string;
    tableName: string;
    triggers: readonly {
      name: string;
      sql: string;
    }[];
  }[];
};

function defaultIssueMessage(code: SqliteSchemaIssueCode, objectName: string): string {
  const tableName = objectName.split(".", 1)[0];
  switch (code) {
    case "missing-table":
      return `missing table ${objectName}`;
    case "missing-column":
    case "unexpected-column":
    case "column-definition-drift":
      return `column definitions differ for ${tableName}`;
    case "table-constraint-drift":
      return `table constraints differ for ${objectName}`;
    case "table-definition-drift":
      return `table definition differs for ${objectName}`;
    case "missing-or-drifted-index":
      return `missing or drifted index ${objectName}`;
    case "unexpected-unique-index":
      return `unexpected unique index ${objectName}`;
    case "missing-or-drifted-trigger":
      return `missing or drifted trigger ${objectName}`;
    case "unexpected-trigger":
      return `unexpected trigger ${objectName}`;
    case "virtual-table-definition-drift":
      return `virtual table definition differs for ${objectName}`;
    case "table-options-drift":
      return `table options differ for ${objectName}`;
  }
  const exhaustiveCode: never = code;
  throw new Error("Unsupported SQLite schema issue code", { cause: exhaustiveCode });
}

export function createSqliteSchemaIssue(
  code: SqliteSchemaIssueCode,
  objectName: string,
  message?: string,
): SqliteSchemaIssue {
  return { code, objectName, message: message ?? defaultIssueMessage(code, objectName) };
}

export function legacySqliteSchemaIssueMessages(issues: readonly SqliteSchemaIssue[]): string[] {
  const isColumnIssue = (issue: SqliteSchemaIssue) =>
    issue.code === "column-definition-drift" ||
    issue.code === "missing-column" ||
    issue.code === "unexpected-column";
  const columnIssueTables = new Set(
    issues.filter(isColumnIssue).map((issue) => issue.objectName.split(".", 1)[0]),
  );
  return [
    ...new Set(
      issues
        .filter(
          (issue) =>
            issue.code !== "table-constraint-drift" || !columnIssueTables.has(issue.objectName),
        )
        .map((issue) => issue.message),
    ),
  ];
}

export function throwSqliteSchemaMismatches(
  databaseLabel: string,
  mismatches: readonly string[],
): never {
  const shown = mismatches.slice(0, 8);
  if (mismatches.length > shown.length) {
    shown.push(`${mismatches.length - shown.length} additional mismatch(es)`);
  }
  throw new Error(
    `SQLite schema is incomplete or noncanonical for ${databaseLabel}: ${shown.join("; ")}`,
  );
}
