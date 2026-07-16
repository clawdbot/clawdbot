// Builds the SQLite sessions/transcripts schema baseline used by CI drift checks.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "../../packages/normalization-core/src/expect.js";

/** Rendered baseline artifact for the sessions/transcripts SQLite schema. */
type SqliteSessionSchemaBaselineRender = {
  /** Normalized SQL for the session, conversation, and transcript schema objects. */
  sql: string;
};

/** Result returned after writing or checking SQLite schema baseline artifacts. */
type SqliteSessionSchemaBaselineWriteResult = {
  /** True when generated artifact content differs from disk. */
  changed: boolean;
  /** True when changed artifacts were actually written. */
  wrote: boolean;
  /** Local inspection SQL artifact path. */
  sqlPath: string;
  /** SHA-256 hash artifact path. */
  hashPath: string;
};

const DEFAULT_SCHEMA_INPUT = "src/state/openclaw-agent-schema.sql";
const DEFAULT_SQL_OUTPUT = ".artifacts/sqlite-session-transcript-schema-baseline.sql";
const DEFAULT_HASH_OUTPUT = "docs/.generated/sqlite-session-transcript-schema-baseline.sha256";

const TARGET_TABLES = new Set([
  "sessions",
  "session_routes",
  "conversations",
  "session_conversations",
  "session_entries",
  "transcript_events",
  "transcript_event_identities",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeIdentifier(value: string): string {
  return value.replace(/^"|"$/g, "").toLowerCase();
}

function splitSqlStatements(sourceSql: string): string[] {
  return sourceSql
    .split(/;\s*(?:\r?\n|$)/u)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function normalizeStatement(statement: string): string {
  const lines = statement
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line, index, allLines) => line.trim() !== "" || index < allLines.length - 1);
  return `${lines.join("\n")};`;
}

function readCreatedTableName(statement: string): string | null {
  const match = statement.match(
    /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\b/iu,
  );
  return match ? normalizeIdentifier(expectDefined(match[1], "created table name")) : null;
}

function readIndexedTableName(statement: string): string | null {
  const match = statement.match(
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+ON\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\b/isu,
  );
  return match ? normalizeIdentifier(expectDefined(match[2], "indexed table name")) : null;
}

function isTargetSessionSchemaStatement(statement: string): boolean {
  const tableName = readCreatedTableName(statement);
  if (tableName) {
    return TARGET_TABLES.has(tableName);
  }

  const indexedTableName = readIndexedTableName(statement);
  return indexedTableName ? TARGET_TABLES.has(indexedTableName) : false;
}

/** Render the normalized sessions/transcripts SQLite schema baseline. */
export function renderSqliteSessionSchemaBaseline(
  agentSchemaSql: string,
): SqliteSessionSchemaBaselineRender {
  const statements = splitSqlStatements(agentSchemaSql)
    .filter(isTargetSessionSchemaStatement)
    .map(normalizeStatement);

  return {
    sql: `${statements.join("\n\n")}\n`,
  };
}

/** Build the sha256 hash file content for the sessions/transcripts SQLite schema baseline. */
export function computeSqliteSessionSchemaBaselineHashFileContent(
  rendered: SqliteSessionSchemaBaselineRender,
): string {
  return `${sha256(rendered.sql)}  sqlite-session-transcript-schema-baseline.sql\n`;
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Write or check SQLite sessions/transcripts schema baseline artifacts. */
export async function writeSqliteSessionSchemaBaselineArtifacts(params: {
  repoRoot: string;
  check: boolean;
  schemaInputPath?: string;
  sqlOutputPath?: string;
  hashOutputPath?: string;
}): Promise<SqliteSessionSchemaBaselineWriteResult> {
  const schemaPath = path.resolve(params.repoRoot, params.schemaInputPath ?? DEFAULT_SCHEMA_INPUT);
  const sqlPath = path.resolve(params.repoRoot, params.sqlOutputPath ?? DEFAULT_SQL_OUTPUT);
  const hashPath = path.resolve(params.repoRoot, params.hashOutputPath ?? DEFAULT_HASH_OUTPUT);
  const sourceSql = await fs.readFile(schemaPath, "utf8");
  const rendered = renderSqliteSessionSchemaBaseline(sourceSql);
  const hash = computeSqliteSessionSchemaBaselineHashFileContent(rendered);
  const existingHash = await readIfExists(hashPath);
  const existingSql = await readIfExists(sqlPath);
  const changed = params.check
    ? existingHash !== hash
    : existingHash !== hash || existingSql !== rendered.sql;

  if (!params.check && changed) {
    await fs.mkdir(path.dirname(sqlPath), { recursive: true });
    await fs.writeFile(sqlPath, rendered.sql);
    await fs.writeFile(hashPath, hash);
  }

  return {
    changed,
    wrote: !params.check && changed,
    sqlPath,
    hashPath,
  };
}
