import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { finished } from "node:stream/promises";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createPrivateSqliteTempDirectory } from "../infra/sqlite-private-directory.js";
import { quoteSqliteIdentifier as quoteIdentifier } from "../infra/sqlite-schema-sql.js";
import { publishVerifiedSqliteFile } from "../infra/sqlite-snapshot.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { getOpenClawStateRuntimeSchema } from "../state/openclaw-state-schema-compatibility.js";
import {
  AGENT_SECRET_TABLE_NAMES,
  STATE_SECRET_CONFIG_STATE_KEY_PREFIXES,
  STATE_SECRET_TABLE_NAMES,
} from "../state/secret-state-tables.js";
import { hashSnapshotArtifact } from "./manifest.js";
import { buildSnapshotValidator } from "./openclaw-snapshot-copy.js";
import { SNAPSHOT_SQLITE_FILENAME } from "./snapshot-provider.js";

export const GIT_BACKUP_MANIFEST = "manifest.json";
export const GIT_BACKUP_SCHEMA = "schema.sql";
export const GIT_BACKUP_TABLES = "tables";

const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const SAFE_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// session_transcript_index_state: Gateway startup transcript reconciliation owns
// rebuilding that FTS projection when the state rows are absent.
// backup_runs: the backup outcome log is written by every backup run, so dumping
// it would make each cycle dirty the next one and defeat no-change detection.
const GIT_BACKUP_PROJECTION_TABLES = ["backup_runs", "session_transcript_index_state"] as const;

export type GitBackupIdentity = { role: "global" } | { role: "agent"; agentId: string };

export type GitBackupManifest = {
  schemaVersion: 1;
  identity: GitBackupIdentity;
  userVersion: number;
  excludedTables: string[];
  excludedConfigStateKeyPrefixes: string[];
  tables: Record<string, { rows: number; sha256: string }>;
};

type GitBackupTableResult = {
  table: string;
  rows: number;
  sha256: string;
  ok: boolean;
};

export type GitBackupRestoreResult = {
  manifest: GitBackupManifest;
  targetPath: string;
  tables: GitBackupTableResult[];
  excludedTables: string[];
  excludedConfigStateKeyPrefixes: string[];
};

type SchemaEntry = {
  type: "index" | "table" | "trigger";
  name: string;
  tableName: string;
  sql: string;
};

function requireSafeTableName(value: string): string {
  if (!SAFE_TABLE_NAME.test(value)) {
    throw new Error(`Git backup table name is not filesystem-safe: ${value}`);
  }
  return value;
}

function normalizeIdentity(identity: GitBackupIdentity): GitBackupIdentity {
  if (identity.role === "global") {
    return identity;
  }
  const agentId = normalizeAgentId(identity.agentId);
  if (agentId !== identity.agentId) {
    throw new Error(`Git backup agent id must be canonical: ${identity.agentId}`);
  }
  return { role: "agent", agentId };
}

export function gitBackupScopePath(identity: GitBackupIdentity): string {
  const normalized = normalizeIdentity(identity);
  return normalized.role === "global" ? "global" : path.join("agents", normalized.agentId);
}

function readSchemaEntries(database: DatabaseSync): SchemaEntry[] {
  return database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
         FROM sqlite_master
        WHERE type IN ('table', 'index', 'trigger')
          AND name NOT LIKE 'sqlite_%'
          AND sql IS NOT NULL
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
    )
    .all()
    .map((row) => row as SchemaEntry);
}

function virtualTableNames(entries: SchemaEntry[]): string[] {
  return entries
    .filter((entry) => /^\s*CREATE\s+VIRTUAL\s+TABLE\b/iu.test(entry.sql))
    .map((entry) => entry.name);
}

function isVirtualShadow(name: string, virtualTables: readonly string[]): boolean {
  return virtualTables.some(
    (virtualTable) => name === virtualTable || name.startsWith(`${virtualTable}_`),
  );
}

// Bound table I/O by a batch plus the largest row, never by the complete table.
const TABLE_BATCH_BYTES = 1024 * 1024;
type TableColumn = { name: string; pk: number };
type GitBackupTableDigest = { rows: number; sha256: string };

function readTableColumns(database: DatabaseSync, table: string): TableColumn[] {
  return database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => {
      const value = row as { name?: unknown; pk?: unknown };
      if (typeof value.name !== "string" || typeof value.pk !== "number") {
        throw new Error(`Unable to read columns for Git backup table ${table}.`);
      }
      return { name: value.name, pk: value.pk };
    });
}

function encodeSqliteValue(value: unknown): unknown {
  if (value === null || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Git backup cannot encode a non-finite SQLite REAL value.");
    }
    return value;
  }
  if (typeof value === "bigint") {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
      ? Number(value)
      : { $int: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { $hex: Buffer.from(value).toString("hex") };
  }
  throw new Error(`Git backup cannot encode SQLite value type ${typeof value}.`);
}

async function serializeGitBackupTable(
  database: DatabaseSync,
  table: string,
  outputPath?: string,
  rowFilter?: (row: Record<string, unknown>) => boolean,
): Promise<GitBackupTableDigest> {
  const columns = readTableColumns(database, table);
  if (columns.length === 0) {
    throw new Error(`Git backup table has no readable columns: ${table}`);
  }
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .toSorted((left, right) => left.pk - right.pk)
    .map((column) => `source.${quoteIdentifier(column.name)}`);
  const orderBy = primaryKey.length > 0 ? primaryKey.join(", ") : "source.rowid";
  // Escape TEXT before node:sqlite can truncate embedded NULs. Keep filtering
  // on decoded values and sorting on source columns, not escaped result aliases.
  const projection = columns.map(({ name }) => {
    const column = quoteIdentifier(name);
    return `CASE WHEN typeof(${column}) = 'text' THEN json_quote(${column}) ELSE ${column} END AS ${column}`;
  });
  const statement = database.prepare(
    `SELECT ${projection.join(", ")}
       FROM ${quoteIdentifier(table)} AS source ORDER BY ${orderBy}`,
  );
  statement.setReadBigInts(true);
  const output = outputPath ? await fs.open(outputPath, "wx", 0o600) : undefined;
  const hash = createHash("sha256");
  const pending: string[] = [];
  let pendingBytes = 0;
  let rows = 0;
  const flush = async () => {
    if (output && pending.length > 0) {
      await output.writeFile(pending.join(""));
      pending.length = 0;
      pendingBytes = 0;
    }
  };
  try {
    for (const rawRow of statement.iterate()) {
      const source: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(rawRow)) {
        source[name] = typeof value === "string" ? JSON.parse(value) : value;
      }
      if (rowFilter && !rowFilter(source)) {
        continue;
      }
      const encoded: Record<string, unknown> = {};
      for (const column of columns) {
        encoded[column.name] = encodeSqliteValue(source[column.name]);
      }
      const line = `${JSON.stringify(encoded)}\n`;
      hash.update(line);
      rows += 1;
      if (output) {
        pending.push(line);
        pendingBytes += Buffer.byteLength(line);
        if (pendingBytes >= TABLE_BATCH_BYTES) {
          await flush();
        }
      }
    }
    await flush();
    return { rows, sha256: hash.digest("hex") };
  } finally {
    await output?.close();
  }
}

function schemaText(entries: SchemaEntry[], userVersion: number): string {
  const statements = entries.map((entry) =>
    entry.sql.trimEnd().endsWith(";") ? entry.sql : `${entry.sql};`,
  );
  return `${statements.join("\n\n")}\n-- PRAGMA user_version = ${userVersion}\n`;
}

function redactedSecretTables(identity: GitBackupIdentity, excludeSecrets: boolean): Set<string> {
  if (!excludeSecrets) {
    return new Set();
  }
  return new Set(identity.role === "global" ? STATE_SECRET_TABLE_NAMES : AGENT_SECRET_TABLE_NAMES);
}

/** Dump one verified SQLite copy into the deterministic Git repository layout. */
export async function dumpGitBackupDatabase(params: {
  snapshotPath: string;
  outputPath: string;
  identity: GitBackupIdentity;
  excludeSecrets?: boolean;
}): Promise<GitBackupManifest> {
  const identity = normalizeIdentity(params.identity);
  const database = openNodeSqliteDatabase(params.snapshotPath, { readOnly: true });
  try {
    const entries = readSchemaEntries(database);
    const virtualTables = virtualTableNames(entries);
    const redacted = redactedSecretTables(identity, params.excludeSecrets === true);
    const existingTables = new Set(
      entries.filter((entry) => entry.type === "table").map((entry) => entry.name),
    );
    // manifest.excludedTables documents redaction only; operational projection
    // tables are always omitted and converge on next gateway startup.
    const excludedTables = [...redacted].filter((table) => existingTables.has(table)).toSorted();
    const excludedConfigStateKeyPrefixes =
      identity.role === "global" &&
      params.excludeSecrets === true &&
      existingTables.has("config_machine_state")
        ? [...STATE_SECRET_CONFIG_STATE_KEY_PREFIXES]
        : [];
    const excluded = new Set([...excludedTables, ...GIT_BACKUP_PROJECTION_TABLES]);
    const includedSchema = entries.filter(
      (entry) => !excluded.has(entry.name) && !excluded.has(entry.tableName),
    );
    const dataTables = entries
      .filter(
        (entry) =>
          entry.type === "table" &&
          !isVirtualShadow(entry.name, virtualTables) &&
          !excluded.has(entry.name),
      )
      .map((entry) => requireSafeTableName(entry.name))
      .toSorted();
    const userVersionRow = database.prepare("PRAGMA user_version").get() as {
      user_version?: unknown;
    };
    if (typeof userVersionRow.user_version !== "number") {
      throw new Error("Unable to read SQLite user_version for Git backup.");
    }
    await fs.rm(params.outputPath, { recursive: true, force: true });
    const tablesPath = path.join(params.outputPath, GIT_BACKUP_TABLES);
    await fs.mkdir(tablesPath, { recursive: true, mode: 0o700 });
    const tables: Record<string, { rows: number; sha256: string }> = {};
    for (const table of dataTables) {
      const rowFilter =
        table === "config_machine_state" && excludedConfigStateKeyPrefixes.length > 0
          ? (row: Record<string, unknown>) => {
              // Fail closed: a malformed state_key is dropped, never risked into a backup.
              const stateKey = row.state_key;
              return (
                typeof stateKey === "string" &&
                !excludedConfigStateKeyPrefixes.some((prefix) => stateKey.startsWith(prefix))
              );
            }
          : undefined;
      tables[table] = await serializeGitBackupTable(
        database,
        table,
        path.join(tablesPath, `${table}.jsonl`),
        rowFilter,
      );
    }
    const manifest: GitBackupManifest = {
      schemaVersion: 1,
      identity,
      userVersion: userVersionRow.user_version,
      excludedTables,
      excludedConfigStateKeyPrefixes,
      tables,
    };
    await fs.writeFile(
      path.join(params.outputPath, GIT_BACKUP_SCHEMA),
      schemaText(includedSchema, manifest.userVersion),
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.writeFile(
      path.join(params.outputPath, GIT_BACKUP_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return manifest;
  } finally {
    database.close();
  }
}

export function parseGitBackupManifest(value: string, source: string): GitBackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Git backup manifest is invalid JSON: ${source}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Git backup manifest is invalid: ${source}`);
  }
  const manifest = parsed as Partial<GitBackupManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.identity ||
    (manifest.identity.role !== "global" && manifest.identity.role !== "agent") ||
    !Number.isSafeInteger(manifest.userVersion) ||
    !Array.isArray(manifest.excludedTables) ||
    (manifest.excludedConfigStateKeyPrefixes !== undefined &&
      (!Array.isArray(manifest.excludedConfigStateKeyPrefixes) ||
        manifest.excludedConfigStateKeyPrefixes.some((prefix) => typeof prefix !== "string"))) ||
    !manifest.tables ||
    typeof manifest.tables !== "object"
  ) {
    throw new Error(`Git backup manifest has unsupported fields: ${source}`);
  }
  const validated = {
    ...manifest,
    excludedConfigStateKeyPrefixes: manifest.excludedConfigStateKeyPrefixes ?? [],
  } as GitBackupManifest;
  normalizeIdentity(validated.identity);
  for (const [table, entry] of Object.entries(validated.tables)) {
    requireSafeTableName(table);
    if (
      !Number.isSafeInteger(entry.rows) ||
      entry.rows < 0 ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(`Git backup manifest has an invalid table entry: ${table}`);
    }
  }
  return validated;
}

function splitSchemaStatements(schema: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | "]" | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < schema.length; index += 1) {
    const character = schema[index]!;
    const next = schema[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if ((quote === "]" && character === "]") || (quote !== "]" && character === quote)) {
        if (quote !== "]" && next === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character !== ";") {
      continue;
    }
    const candidate = schema.slice(start, index + 1).trim();
    if (/^CREATE\s+TRIGGER\b/iu.test(candidate) && !/\bEND\s*;$/iu.test(candidate)) {
      continue;
    }
    if (candidate && !candidate.startsWith("-- PRAGMA user_version")) {
      statements.push(candidate);
    }
    start = index + 1;
  }
  return statements;
}

function unquoteSqlIdentifier(value: string): string {
  if (value.startsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) {
    return value.slice(1, -1).replaceAll('""', '"');
  }
  if (value.startsWith("`")) {
    return value.slice(1, -1).replaceAll("``", "`");
  }
  if (value.startsWith("[")) {
    return value.slice(1, -1);
  }
  return value;
}

function schemaObjectName(statement: string, kind: "table" | "virtual"): string | undefined {
  const prefix = kind === "virtual" ? "CREATE\\s+VIRTUAL\\s+TABLE" : "CREATE\\s+TABLE";
  const match = new RegExp(
    `^${prefix}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?('(?:[^']|'')*'|"(?:[^"]|"")*"|\\[[^\\]]+\\]|\`(?:[^\`]|\`\`)*\`|[^\\s(]+)`,
    "iu",
  ).exec(statement);
  return match?.[1] ? unquoteSqlIdentifier(match[1]) : undefined;
}

function decodeSqliteValue(value: unknown): null | string | number | bigint | Buffer {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Git backup row contains an invalid encoded value.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && typeof record.$int === "string") {
    return BigInt(record.$int);
  }
  if (
    Object.keys(record).length === 1 &&
    typeof record.$hex === "string" &&
    /^(?:[a-f0-9]{2})*$/u.test(record.$hex)
  ) {
    return Buffer.from(record.$hex, "hex");
  }
  throw new Error("Git backup row contains an invalid encoded object.");
}

async function assertFreshRestoreTarget(targetPath: string): Promise<void> {
  for (const candidate of [
    targetPath,
    ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${targetPath}${suffix}`),
  ]) {
    try {
      await fs.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    throw new Error(`Fresh SQLite restore path already exists: ${candidate}`);
  }
}

function assertNoSqliteSidecarsSync(targetPath: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${targetPath}${suffix}`;
    try {
      fsSync.lstatSync(sidecarPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    throw new Error(`Fresh SQLite restore path already exists: ${sidecarPath}`);
  }
}

function convergeRestoredSchema(database: DatabaseSync, identity: GitBackupIdentity): void {
  database.exec(
    identity.role === "global"
      ? getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false })
      : OPENCLAW_AGENT_SCHEMA_SQL,
  );
}

function validateRestoredOwner(
  database: DatabaseSync,
  databasePath: string,
  identity: GitBackupIdentity,
): void {
  assertSqliteIntegrity(database, databasePath);
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new Error(`SQLite foreign_key_check failed for restored Git backup: ${databasePath}`);
  }
  buildSnapshotValidator(identity)(database, databasePath);
}

/** Load and hash one JSONL table without retaining the whole artifact. */
async function loadGitBackupTable(
  database: DatabaseSync,
  table: string,
  inputPath: string,
): Promise<GitBackupTableDigest> {
  const columns = readTableColumns(database, table);
  const statement = database.prepare(
    `INSERT INTO ${quoteIdentifier(table)} (${columns.map((column) => quoteIdentifier(column.name)).join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  );
  const input = fsSync.createReadStream(inputPath);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const hash = createHash("sha256");
  input.on("data", (chunk: Buffer) => hash.update(chunk));
  const pending: Array<ReturnType<typeof decodeSqliteValue>[]> = [];
  let pendingBytes = 0;
  let rows = 0;
  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    // This database is private staging. Only verified publication exposes it;
    // disk reads stay outside these bounded synchronous insert transactions.
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const values of pending) {
        statement.run(...values);
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    pending.length = 0;
    pendingBytes = 0;
  };
  try {
    for await (const line of lines) {
      if (!line) {
        continue;
      }
      const parsed = JSON.parse(line) as Record<string, unknown>;
      pending.push(columns.map((column) => decodeSqliteValue(parsed[column.name])));
      pendingBytes += Buffer.byteLength(line);
      rows += 1;
      if (pendingBytes >= TABLE_BATCH_BYTES) {
        flush();
      }
    }
    flush();
    return { rows, sha256: hash.digest("hex") };
  } finally {
    lines.close();
    input.destroy();
    await finished(input).catch(() => undefined);
  }
}

/** Restore one materialized Git snapshot scope into a fresh SQLite file. */
export async function restoreGitBackupDirectory(params: {
  sourcePath: string;
  targetPath: string;
  expectedIdentity?: GitBackupIdentity;
}): Promise<GitBackupRestoreResult> {
  const targetPath = path.resolve(params.targetPath);
  await assertFreshRestoreTarget(targetPath);
  const manifest = parseGitBackupManifest(
    await fs.readFile(path.join(params.sourcePath, GIT_BACKUP_MANIFEST), "utf8"),
    params.sourcePath,
  );
  const restoreIdentity = normalizeIdentity(params.expectedIdentity ?? manifest.identity);
  if (
    params.expectedIdentity &&
    JSON.stringify(normalizeIdentity(manifest.identity)) !== JSON.stringify(restoreIdentity)
  ) {
    throw new Error("Git backup manifest database identity does not match the requested scope.");
  }
  const schema = await fs.readFile(path.join(params.sourcePath, GIT_BACKUP_SCHEMA), "utf8");
  const statements = splitSchemaStatements(schema);
  const virtual = statements.filter((statement) => /^CREATE\s+VIRTUAL\s+TABLE\b/iu.test(statement));
  const triggers = statements.filter((statement) => /^CREATE\s+TRIGGER\b/iu.test(statement));
  const virtualNames = virtual
    .map((statement) => schemaObjectName(statement, "virtual"))
    .filter((value): value is string => Boolean(value));
  const plainTables = statements.filter((statement) => {
    if (!/^CREATE\s+TABLE\b/iu.test(statement)) {
      return false;
    }
    const name = schemaObjectName(statement, "table");
    return !name || !isVirtualShadow(name, virtualNames);
  });
  const indexes = statements.filter((statement) =>
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu.test(statement),
  );
  const targetDirectory = path.dirname(targetPath);
  await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const stagingDirectory = await createPrivateSqliteTempDirectory(
    targetDirectory,
    ".git-backup-restore-",
  );
  applyPrivateModeSync(stagingDirectory, 0o700);
  const stagedPath = path.join(stagingDirectory, SNAPSHOT_SQLITE_FILENAME);
  const stagedHandle = await fs.open(stagedPath, "wx", 0o600);
  await stagedHandle.close();
  const database = openNodeSqliteDatabase(stagedPath);
  try {
    database.exec("PRAGMA foreign_keys = OFF; PRAGMA journal_mode = DELETE;");
    for (const statement of [...plainTables, ...indexes]) {
      database.exec(statement);
    }
    for (const [table, expected] of Object.entries(manifest.tables)) {
      requireSafeTableName(table);
      const actual = await loadGitBackupTable(
        database,
        table,
        path.join(params.sourcePath, GIT_BACKUP_TABLES, `${table}.jsonl`),
      );
      if (actual.sha256 !== expected.sha256) {
        throw new Error(`Git backup table hash mismatch: ${table}`);
      }
      if (actual.rows !== expected.rows) {
        throw new Error(`Git backup table row count mismatch: ${table}`);
      }
    }
    for (const statement of virtual) {
      if (/\bUSING\s+vec0\b/iu.test(statement)) {
        continue;
      }
      database.exec(statement);
    }
    for (const statement of triggers) {
      database.exec(statement);
    }
    for (const statement of virtual) {
      const name = schemaObjectName(statement, "virtual");
      if (name && /\bUSING\s+fts5\b/iu.test(statement) && /\bcontent\s*=/iu.test(statement)) {
        database
          .prepare(
            `INSERT INTO ${quoteIdentifier(name)} (${quoteIdentifier(name)}) VALUES ('rebuild')`,
          )
          .run();
      }
    }
    // Contentless transcript FTS stays empty. Omission of session_transcript_index_state
    // makes Gateway startup reconciliation rebuild that projection from transcripts.
    database.exec(`PRAGMA user_version = ${manifest.userVersion};`);
    // Redacted and operational projection tables are absent from Git. Recreate
    // their canonical empty schemas before enforcing database ownership.
    convergeRestoredSchema(database, restoreIdentity);
    validateRestoredOwner(database, stagedPath, restoreIdentity);
    const tables: GitBackupTableResult[] = [];
    for (const [table, expected] of Object.entries(manifest.tables)) {
      const actual = await serializeGitBackupTable(database, table);
      tables.push({
        table,
        ...actual,
        ok: actual.rows === expected.rows && actual.sha256 === expected.sha256,
      });
    }
    if (tables.some((table) => !table.ok)) {
      throw new Error(`Restored Git backup does not match its table manifest: ${stagedPath}`);
    }
    database.close();
    applyPrivateModeSync(stagedPath, 0o600);
    const artifact = await hashSnapshotArtifact(stagingDirectory);
    await publishVerifiedSqliteFile({
      sourceIdentity: artifact.stat,
      sourcePath: stagedPath,
      targetPath,
      expectedContent: artifact,
      requireAtomicPublication: true,
      beforePublish: async () => await assertFreshRestoreTarget(targetPath),
      validatePublished: async (publishedPath) => {
        const published = openNodeSqliteDatabase(publishedPath, { readOnly: true });
        try {
          validateRestoredOwner(published, publishedPath, restoreIdentity);
        } finally {
          published.close();
        }
      },
      afterPublish: (guard) => {
        guard.assertTargetMatchesExpectedContent(() => assertNoSqliteSidecarsSync(targetPath));
      },
    });
    return {
      manifest,
      targetPath,
      tables,
      excludedTables: manifest.excludedTables,
      // Older backups predate prefix redaction; absent means nothing was omitted.
      excludedConfigStateKeyPrefixes: manifest.excludedConfigStateKeyPrefixes ?? [],
    };
  } catch (error) {
    if (database.isOpen) {
      database.close();
    }
    throw error;
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
