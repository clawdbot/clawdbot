import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { repairCanonicalSqliteIndexes } from "../../src/infra/sqlite-index-schema.js";
import { assertSqliteIntegrity } from "../../src/infra/sqlite-integrity.js";
import {
  formatReliabilityStderr,
  INDEX_REPAIR_INDEX_NAME,
  INDEX_REPAIR_SCHEMA_SQL,
  type IndexRepairJournalMode,
  type ReliabilityReport,
} from "./sqlite-reliability-contract.js";

type IndexRepairProof = ReliabilityReport["indexRepairInterruptionProof"]["rollbackJournal"];

type IndexRepairState = {
  rows: number;
  sha256: string;
};

type WorkerExit = IndexRepairProof["exit"];

const INDEX_REPAIR_WORKER_PATH = fileURLToPath(
  new URL("./sqlite-reliability-index-repair-worker.ts", import.meta.url),
);
// Keep enough index pages to spill both rollback-journal and WAL transactions
// before the worker reports its explicit crash point.
const INDEX_REPAIR_ROWS = 16_384;
const INDEX_REPAIR_TIMEOUT_MS = 30_000;

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function readIndexRepairState(database: DatabaseSync): IndexRepairState {
  const hash = createHash("sha256");
  let rows = 0;
  const entries = database
    .prepare(
      `SELECT id, identity, payload
         FROM openclaw_reliability_index_records
        ORDER BY id`,
    )
    .iterate() as Iterable<{ id?: unknown; identity?: unknown; payload?: unknown }>;
  for (const entry of entries) {
    hash.update(JSON.stringify([entry.id, entry.identity, entry.payload]));
    hash.update("\n");
    rows += 1;
  }
  return { rows, sha256: hash.digest("hex") };
}

function assertSameState(actual: IndexRepairState, expected: IndexRepairState): void {
  if (actual.rows !== expected.rows || actual.sha256 !== expected.sha256) {
    throw new Error(
      `index repair interruption changed database rows: expected rows=${expected.rows} sha256=${expected.sha256}, got rows=${actual.rows} sha256=${actual.sha256}`,
    );
  }
}

function prepareIndexRepairDatabase(
  databasePath: string,
  journalMode: IndexRepairJournalMode,
): IndexRepairState {
  const database = openNodeSqliteDatabase(databasePath);
  try {
    database.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA journal_mode = ${journalMode === "wal" ? "WAL" : "DELETE"};
      CREATE TABLE openclaw_reliability_index_records (
        id INTEGER PRIMARY KEY,
        identity TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      BEGIN IMMEDIATE;
    `);
    const insert = database.prepare(
      `INSERT INTO openclaw_reliability_index_records (id, identity, payload)
       VALUES (?, ?, ?)`,
    );
    try {
      for (let id = 1; id <= INDEX_REPAIR_ROWS; id += 1) {
        insert.run(id, `identity-${id.toString().padStart(6, "0")}`, "x".repeat(2_048));
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    database.exec(
      `CREATE INDEX ${INDEX_REPAIR_INDEX_NAME}
         ON openclaw_reliability_index_records(payload);`,
    );
    if (journalMode === "wal") {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    return readIndexRepairState(database);
  } finally {
    database.close();
  }
}

async function waitForWorkerMessage(params: {
  action?: () => void;
  child: ChildProcess;
  kind: "crash-point" | "ready";
  readStderr: () => string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `SQLite index repair worker did not report ${params.kind}.${formatReliabilityStderr(params.readStderr())}`,
        ),
      );
    }, INDEX_REPAIR_TIMEOUT_MS);
    const onMessage = (message: unknown) => {
      if (
        !message ||
        typeof message !== "object" ||
        (message as { kind?: unknown }).kind !== params.kind
      ) {
        return;
      }
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `SQLite index repair worker exited before ${params.kind}: code=${String(code)} signal=${String(signal)}.${formatReliabilityStderr(params.readStderr())}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      params.child.off("message", onMessage);
      params.child.off("error", onError);
      params.child.off("exit", onExit);
    };
    params.child.on("message", onMessage);
    params.child.on("error", onError);
    params.child.on("exit", onExit);
    params.action?.();
  });
}

async function waitForActiveTransaction(params: {
  child: ChildProcess;
  databasePath: string;
  journalMode: IndexRepairJournalMode;
  readStderr: () => string;
}): Promise<{ journalBytes: number; walBytes: number }> {
  const deadline = Date.now() + INDEX_REPAIR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const journalBytes = fileSize(`${params.databasePath}-journal`);
    const walBytes = fileSize(`${params.databasePath}-wal`);
    const activeBytes = params.journalMode === "wal" ? walBytes : journalBytes;
    if (activeBytes > 0) {
      return { journalBytes, walBytes };
    }
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new Error(
        `SQLite index repair completed before ${params.journalMode} interruption evidence was observed.${formatReliabilityStderr(params.readStderr())}`,
      );
    }
    await delay(2);
  }
  throw new Error(
    `SQLite index repair did not produce active ${params.journalMode} evidence within 30 seconds.`,
  );
}

async function waitForChildExit(child: ChildProcess): Promise<WorkerExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise<WorkerExit>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("SQLite index repair worker did not exit after forced termination."));
    }, INDEX_REPAIR_TIMEOUT_MS);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function assertForcedExit(exit: WorkerExit): void {
  if (exit.code === 0) {
    throw new Error("SQLite index repair worker exited cleanly before forced termination.");
  }
  if (process.platform === "win32") {
    if (exit.code === null && exit.signal === null) {
      throw new Error("SQLite index repair worker reported no forced Windows exit.");
    }
    return;
  }
  if (exit.signal !== "SIGKILL") {
    throw new Error(
      `SQLite index repair worker exited without SIGKILL: code=${String(exit.code)} signal=${String(exit.signal)}`,
    );
  }
}

function recoverAndRepair(databasePath: string, expectedState: IndexRepairState): string[] {
  const database = openNodeSqliteDatabase(databasePath);
  try {
    assertSqliteIntegrity(database, databasePath);
    assertSameState(readIndexRepairState(database), expectedState);
    const probeIndexes = database
      .prepare(
        "SELECT name FROM main.sqlite_schema WHERE type = 'index' AND name LIKE 'openclaw_probe_%'",
      )
      .all();
    if (probeIndexes.length > 0) {
      throw new Error(`index repair recovery left ${probeIndexes.length} probe index(es)`);
    }
    const repairedIndexes = repairCanonicalSqliteIndexes(
      database,
      databasePath,
      INDEX_REPAIR_SCHEMA_SQL,
    );
    if (repairedIndexes.length !== 1 || repairedIndexes[0] !== INDEX_REPAIR_INDEX_NAME) {
      throw new Error(
        `index repair retry repaired unexpected indexes: ${repairedIndexes.join(", ") || "none"}`,
      );
    }
    if (
      repairCanonicalSqliteIndexes(database, databasePath, INDEX_REPAIR_SCHEMA_SQL).length !== 0
    ) {
      throw new Error("canonical index repair was not idempotent after crash recovery");
    }
    assertSqliteIntegrity(database, databasePath);
    assertSameState(readIndexRepairState(database), expectedState);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    return repairedIndexes;
  } finally {
    database.close();
  }
}

async function runJournalModeProof(params: {
  databasePath: string;
  journalMode: IndexRepairJournalMode;
}): Promise<IndexRepairProof> {
  const expectedState = prepareIndexRepairDatabase(params.databasePath, params.journalMode);
  let stderr = "";
  const child = fork(INDEX_REPAIR_WORKER_PATH, [params.databasePath, params.journalMode], {
    execArgv: ["--import", "tsx"],
    serialization: "json",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForWorkerMessage({
      child,
      kind: "ready",
      readStderr: () => stderr,
    });
    await waitForWorkerMessage({
      action: () => child.send?.({ kind: "start" }),
      child,
      kind: "crash-point",
      readStderr: () => stderr,
    });
    const observed = await waitForActiveTransaction({
      child,
      databasePath: params.databasePath,
      journalMode: params.journalMode,
      readStderr: () => stderr,
    });
    if (!child.kill("SIGKILL")) {
      throw new Error("SQLite index repair worker exited before the crash signal was delivered.");
    }
    const exit = await waitForChildExit(child);
    assertForcedExit(exit);
    const repairedIndexes = recoverAndRepair(params.databasePath, expectedState);
    return {
      exit,
      journalBytesObserved: observed.journalBytes,
      repairedIndexes,
      recoveryVerified: true,
      rowsPreserved: expectedState.rows,
      walBytesObserved: observed.walBytes,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildExit(child).catch(() => undefined);
    }
  }
}

export async function runIndexRepairInterruptionProof(
  scratchPath: string,
): Promise<ReliabilityReport["indexRepairInterruptionProof"]> {
  fs.mkdirSync(scratchPath, { recursive: true, mode: 0o700 });
  return {
    rollbackJournal: await runJournalModeProof({
      databasePath: path.join(scratchPath, "index-repair-delete.sqlite"),
      journalMode: "delete",
    }),
    wal: await runJournalModeProof({
      databasePath: path.join(scratchPath, "index-repair-wal.sqlite"),
      journalMode: "wal",
    }),
  };
}
