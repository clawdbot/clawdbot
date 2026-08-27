import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { repairCanonicalSqliteIndexes } from "../../src/infra/sqlite-index-schema.js";
import {
  INDEX_REPAIR_SCHEMA_SQL,
  type IndexRepairJournalMode,
} from "./sqlite-reliability-contract.js";

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function parseJournalMode(value: string | undefined): IndexRepairJournalMode {
  if (value === "delete" || value === "wal") {
    return value;
  }
  throw new Error(`invalid SQLite index repair journal mode: ${String(value)}`);
}

async function waitForStart(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("message", (message: unknown) => {
      if (
        !message ||
        typeof message !== "object" ||
        (message as { kind?: unknown }).kind !== "start"
      ) {
        throw new Error("SQLite index repair worker received an invalid start message.");
      }
      resolve();
    });
  });
}

async function main(argv: string[]): Promise<void> {
  const [databasePath, journalModeValue, ...extra] = argv;
  if (extra.length > 0 || !databasePath) {
    throw new Error("invalid SQLite index repair worker arguments");
  }
  const journalMode = parseJournalMode(journalModeValue);
  const database = openNodeSqliteDatabase(databasePath);
  try {
    database.exec(`
      PRAGMA busy_timeout = 30000;
      PRAGMA cache_size = 64;
      PRAGMA cache_spill = ON;
      PRAGMA synchronous = FULL;
      PRAGMA journal_mode = ${journalMode === "wal" ? "WAL" : "DELETE"};
      PRAGMA wal_autocheckpoint = 0;
    `);
    const originalExec = database.exec.bind(database);
    Object.defineProperty(database, "exec", {
      configurable: true,
      value: (sql: string) => {
        originalExec(sql);
        // The repair drops its probe only after replacing the canonical index.
        // Pause here with every repair DDL change inside the unreleased savepoint.
        if (sql.startsWith("DROP INDEX main.openclaw_probe_")) {
          process.send?.({ kind: "crash-point" });
          while (true) {
            Atomics.wait(SLEEP_BUFFER, 0, 0, 60_000);
          }
        }
      },
    });
    process.send?.({ kind: "ready" });
    await waitForStart();
    repairCanonicalSqliteIndexes(database, databasePath, INDEX_REPAIR_SCHEMA_SQL);
    process.send?.({ kind: "completed" });
  } finally {
    database.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2));
}
