import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { inspectPathPermissions } from "./permissions.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const RECEIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type UpdateLedgerLocator = Readonly<{
  databasePath: string;
  installRoot: string;
}>;

export type UpdateLedgerSnapshot = Readonly<{
  payloadJson: string;
  receiptId: string;
  revision: number;
}>;

export type UpdateLedgerCompareAndSwapResult =
  | { status: "stored" | "replayed"; snapshot: UpdateLedgerSnapshot }
  | { status: "conflict"; snapshot: UpdateLedgerSnapshot | null };

type UpdateLedgerRow = {
  payload_json: string;
  receipt_id: string;
  revision: number;
};

function assertAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`Update ledger ${label} must be an absolute path`);
  }
  return value;
}

/** Resolve once before transfer; parsing in another process preserves the exact database path. */
export function resolveUpdateLedgerLocator(params: {
  databasePath: string;
  installRoot: string;
}): UpdateLedgerLocator {
  const databasePath = path.resolve(params.databasePath);
  return {
    databasePath: path.join(
      fs.realpathSync.native(path.dirname(databasePath)),
      path.basename(databasePath),
    ),
    installRoot: resolveUpdateInstallRoot(params.installRoot),
  };
}

export function parseUpdateLedgerLocator(value: unknown): UpdateLedgerLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid update ledger locator");
  }
  const locator = value as Record<string, unknown>;
  return {
    databasePath: assertAbsolutePath(locator.databasePath, "database path"),
    installRoot: resolveUpdateInstallRoot(assertAbsolutePath(locator.installRoot, "install root")),
  };
}

function assertReceiptId(value: string): string {
  if (!RECEIPT_ID_PATTERN.test(value)) {
    throw new Error("Invalid update ledger receipt id");
  }
  return value;
}

function assertPayloadJson(value: string): string {
  if (Buffer.byteLength(value) > MAX_PAYLOAD_BYTES) {
    throw new Error("Update ledger payload exceeds the byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Update ledger payload must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Update ledger payload must be a JSON object");
  }
  return value;
}

async function assertSafeDatabaseAncestry(targetPath: string): Promise<void> {
  const root = path.parse(targetPath).root;
  let current = root;
  for (const component of path.relative(root, targetPath).split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Update ledger path must not contain symbolic links");
      }
      const permissions = await inspectPathPermissions(current);
      if (
        !permissions.ok ||
        (process.platform === "win32" && permissions.source !== "windows-acl")
      ) {
        throw new Error("Update ledger database ancestry could not be verified");
      }
      if (process.platform === "win32") {
        if (
          permissions.ownerTrusted !== true ||
          permissions.groupWritable ||
          permissions.worldWritable
        ) {
          throw new Error("Update ledger database ancestry is not owner-controlled");
        }
      } else {
        const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
        const trustedOwner = currentUid === undefined || stat.uid === 0 || stat.uid === currentUid;
        const externallyWritable = (stat.mode & 0o022) !== 0;
        const sticky = (stat.mode & 0o1000) !== 0;
        if (!trustedOwner || (externallyWritable && !sticky)) {
          throw new Error("Update ledger database ancestry is not owner-controlled");
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

async function assertPrivateDatabaseDirectory(databasePath: string): Promise<void> {
  const directory = path.dirname(databasePath);
  await assertSafeDatabaseAncestry(directory);
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Update ledger directory must not be a symbolic link");
  }
  if (process.platform === "win32") {
    const permissions = await inspectPathPermissions(directory);
    if (
      !permissions.ok ||
      permissions.source !== "windows-acl" ||
      permissions.ownerTrusted !== true ||
      permissions.groupReadable ||
      permissions.worldReadable ||
      permissions.groupWritable ||
      permissions.worldWritable
    ) {
      throw new Error("Update ledger directory ACL must grant only trusted principals");
    }
  } else {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      (currentUid !== undefined && directoryStat.uid !== currentUid) ||
      (directoryStat.mode & 0o077) !== 0
    ) {
      throw new Error("Update ledger directory must be private and owned by the current user");
    }
  }
}

async function inspectPrivateDatabaseFile(databasePath: string): Promise<fs.Stats | null> {
  let databaseStat: fs.Stats;
  try {
    databaseStat = fs.lstatSync(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) {
    throw new Error("Update ledger path must be a regular file");
  }
  if (process.platform === "win32") {
    const permissions = await inspectPathPermissions(databasePath);
    if (
      !permissions.ok ||
      permissions.source !== "windows-acl" ||
      permissions.ownerTrusted !== true ||
      permissions.groupReadable ||
      permissions.worldReadable ||
      permissions.groupWritable ||
      permissions.worldWritable
    ) {
      throw new Error("Update ledger file ACL must grant only trusted principals");
    }
  } else {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      (currentUid !== undefined && databaseStat.uid !== currentUid) ||
      (databaseStat.mode & 0o077) !== 0
    ) {
      throw new Error("Existing update ledger file must be private");
    }
  }
  return databaseStat;
}

async function ensurePrivateDatabaseFile(databasePath: string): Promise<void> {
  await assertPrivateDatabaseDirectory(databasePath);
  const existing = await inspectPrivateDatabaseFile(databasePath);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let created = false;
  let file: number;
  if (!existing) {
    try {
      file = fs.openSync(
        databasePath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | noFollow,
        0o600,
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      await inspectPrivateDatabaseFile(databasePath);
      file = fs.openSync(databasePath, fs.constants.O_RDWR | noFollow);
    }
  } else {
    file = fs.openSync(databasePath, fs.constants.O_RDWR | noFollow);
  }
  if (created && process.platform !== "win32") {
    fs.fchmodSync(file, 0o600);
  }
  fs.closeSync(file);
  try {
    await inspectPrivateDatabaseFile(databasePath);
  } catch (error) {
    if (created) {
      fs.rmSync(databasePath, { force: true });
    }
    throw error;
  }
}

async function openLedger(
  locator: UpdateLedgerLocator,
  create: boolean,
): Promise<DatabaseSync | null> {
  if (create) {
    await ensurePrivateDatabaseFile(locator.databasePath);
  } else {
    await assertPrivateDatabaseDirectory(locator.databasePath);
    if (!(await inspectPrivateDatabaseFile(locator.databasePath))) {
      return null;
    }
  }
  // Existing reads stay writable so SQLite can roll back a hot DELETE-mode journal after a crash.
  const database = openNodeSqliteDatabase(locator.databasePath);
  try {
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`); // sqlite-allow-raw -- fixed lock wait.
    let currentVersion = (database.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (currentVersion === 0 && !create) {
      database.close();
      return null;
    }
    if (currentVersion === 0) {
      database.exec("BEGIN IMMEDIATE"); // sqlite-allow-raw -- serialize first-use schema ownership.
      try {
        currentVersion = (database.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version;
        if (currentVersion === 0) {
          const existingObject = database
            .prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
            .get();
          if (existingObject) {
            throw new Error("Refusing to initialize an update ledger in a nonempty database");
          }
          database.exec(`
            CREATE TABLE update_ledger_heads (
              install_root TEXT PRIMARY KEY NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0),
              receipt_id TEXT NOT NULL,
              payload_json TEXT NOT NULL
            ) STRICT;
            CREATE TABLE update_ledger_receipts (
              install_root TEXT NOT NULL,
              receipt_id TEXT NOT NULL,
              expected_revision INTEGER,
              revision INTEGER NOT NULL CHECK (revision > 0),
              payload_json TEXT NOT NULL,
              PRIMARY KEY (install_root, receipt_id)
            ) STRICT;
            PRAGMA user_version = ${SCHEMA_VERSION};
          `); // sqlite-allow-raw -- dedicated first-use schema.
          currentVersion = SCHEMA_VERSION;
        }
        database.exec("COMMIT"); // sqlite-allow-raw -- schema and version publish atomically.
      } catch (error) {
        database.exec("ROLLBACK"); // sqlite-allow-raw -- release first-use schema ownership.
        throw error;
      }
    }
    if (currentVersion !== SCHEMA_VERSION) {
      throw new Error("Unsupported update ledger schema");
    }
    if (create) {
      database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;"); // sqlite-allow-raw -- durability policy.
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function parseRow(row: UpdateLedgerRow | undefined): UpdateLedgerSnapshot | null {
  if (!row) {
    return null;
  }
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new Error("Invalid update ledger revision");
  }
  return {
    payloadJson: assertPayloadJson(row.payload_json),
    receiptId: assertReceiptId(row.receipt_id),
    revision: row.revision,
  };
}

function readHead(database: DatabaseSync, installRoot: string): UpdateLedgerSnapshot | null {
  return parseRow(
    database
      .prepare(
        "SELECT revision, receipt_id, payload_json FROM update_ledger_heads WHERE install_root = ?",
      )
      .get(installRoot) as UpdateLedgerRow | undefined,
  );
}

export async function readUpdateLedger(
  locator: UpdateLedgerLocator,
): Promise<UpdateLedgerSnapshot | null> {
  const resolved = parseUpdateLedgerLocator(locator);
  const database = await openLedger(resolved, false);
  try {
    return database ? readHead(database, resolved.installRoot) : null;
  } finally {
    database?.close();
  }
}

export async function readUpdateLedgerReceipt(params: {
  locator: UpdateLedgerLocator;
  receiptId: string;
}): Promise<UpdateLedgerSnapshot | null> {
  const locator = parseUpdateLedgerLocator(params.locator);
  const database = await openLedger(locator, false);
  try {
    return database
      ? parseRow(
          database
            .prepare(
              "SELECT revision, receipt_id, payload_json FROM update_ledger_receipts WHERE install_root = ? AND receipt_id = ?",
            )
            .get(locator.installRoot, assertReceiptId(params.receiptId)) as
            | UpdateLedgerRow
            | undefined,
        )
      : null;
  } finally {
    database?.close();
  }
}

export async function compareAndSwapUpdateLedger(params: {
  expectedRevision: number | null;
  locator: UpdateLedgerLocator;
  payloadJson: string;
  receiptId: string;
}): Promise<UpdateLedgerCompareAndSwapResult> {
  const locator = parseUpdateLedgerLocator(params.locator);
  const receiptId = assertReceiptId(params.receiptId);
  const payloadJson = assertPayloadJson(params.payloadJson);
  if (
    params.expectedRevision !== null &&
    (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1)
  ) {
    throw new Error("Invalid expected update ledger revision");
  }
  const database = await openLedger(locator, true);
  if (!database) {
    throw new Error("Update ledger could not be opened");
  }
  try {
    return runSqliteImmediateTransactionSync(
      database,
      () => {
        const receipt = database
          .prepare(
            "SELECT expected_revision, revision, receipt_id, payload_json FROM update_ledger_receipts WHERE install_root = ? AND receipt_id = ?",
          )
          .get(locator.installRoot, receiptId) as
          | (UpdateLedgerRow & { expected_revision: number | null })
          | undefined;
        if (receipt) {
          if (
            receipt.expected_revision !== params.expectedRevision ||
            receipt.payload_json !== payloadJson
          ) {
            throw new Error("Update ledger receipt was replayed with different content");
          }
          return { status: "replayed", snapshot: parseRow(receipt)! };
        }
        const current = readHead(database, locator.installRoot);
        if ((current?.revision ?? null) !== params.expectedRevision) {
          return { status: "conflict", snapshot: current };
        }
        const revision = (current?.revision ?? 0) + 1;
        database
          .prepare(
            "INSERT INTO update_ledger_receipts (install_root, receipt_id, expected_revision, revision, payload_json) VALUES (?, ?, ?, ?, ?)",
          )
          .run(locator.installRoot, receiptId, params.expectedRevision, revision, payloadJson);
        database
          .prepare(
            "INSERT INTO update_ledger_heads (install_root, revision, receipt_id, payload_json) VALUES (?, ?, ?, ?) ON CONFLICT (install_root) DO UPDATE SET revision = excluded.revision, receipt_id = excluded.receipt_id, payload_json = excluded.payload_json",
          )
          .run(locator.installRoot, revision, receiptId, payloadJson);
        return {
          status: "stored",
          snapshot: { payloadJson, receiptId, revision },
        };
      },
      {
        busyTimeoutMs: BUSY_TIMEOUT_MS,
        databaseLabel: "update-ledger",
        operationLabel: "update-ledger.compare-and-swap",
      },
    );
  } finally {
    database.close();
  }
}
