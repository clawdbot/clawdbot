import { parentPort, workerData } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  markSqliteReclamationSettled,
  waitForSqliteReclamationCommit,
} from "./session-accessor.sqlite-reclamation-commit.js";

type CommitFixture = {
  databasePath: string;
  gate: SharedArrayBuffer;
  progress: SharedArrayBuffer;
  holdAfterApproval?: boolean;
  outcome?: "rollback" | "exit-before-commit" | "exit-after-commit";
};

const port = parentPort;
if (!port) {
  throw new Error("commit fixture requires a Worker parent port");
}

const fixture = workerData as CommitFixture;
const progress = new Int32Array(fixture.progress);
const database = openNodeSqliteDatabase(fixture.databasePath);
database.exec("BEGIN IMMEDIATE; UPDATE proof SET value = 2");
try {
  waitForSqliteReclamationCommit(fixture.gate, () => port.postMessage("commit-request"));
  Atomics.store(progress, 0, 1);
  Atomics.notify(progress, 0);
  if (fixture.holdAfterApproval) {
    Atomics.wait(progress, 1, 0);
  }
  if (fixture.outcome === "exit-before-commit") {
    process.exit(7);
  }
  if (fixture.outcome === "rollback") {
    throw new Error("injected worker transaction failure");
  }
  database.exec("COMMIT");
  if (fixture.outcome === "exit-after-commit") {
    process.exit(9);
  }
} catch (error) {
  if (database.isTransaction) {
    database.exec("ROLLBACK");
  }
  port.postMessage({ error: String(error) });
} finally {
  database.close();
  markSqliteReclamationSettled(fixture.gate);
  Atomics.store(progress, 0, 2);
  Atomics.notify(progress, 0);
}
