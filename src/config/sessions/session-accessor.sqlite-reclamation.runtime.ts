import type { DatabaseSync } from "node:sqlite";
import type { MessagePort } from "node:worker_threads";
import {
  settleOpenClawAgentDatabaseWorkerClose,
  type OpenClawAgentDatabaseWorkerCloseResult,
} from "../../state/openclaw-agent-db.js";
import {
  markSqliteReclamationSettled,
  waitForSqliteReclamationCommit,
} from "./session-accessor.sqlite-reclamation-commit.js";
import {
  reclaimSqliteSessionInTransaction,
  type SqliteSessionReclamationWorkerData,
  type SqliteSessionReclamationWorkerResult,
} from "./session-accessor.sqlite-reclamation.js";

const WORKER_CLOSE_MAX_ATTEMPTS = 3;

async function settleReclamationDatabase(
  pathname: string,
): Promise<{ cleanupWarnings: string[]; settled: boolean }> {
  const warnings = new Set<string>();
  let outcome: OpenClawAgentDatabaseWorkerCloseResult = { errors: [], settled: false };
  for (let attempt = 0; attempt < WORKER_CLOSE_MAX_ATTEMPTS; attempt += 1) {
    outcome = settleOpenClawAgentDatabaseWorkerClose(pathname);
    outcome.errors.forEach((error) => warnings.add(error.message));
    if (outcome.settled) {
      break;
    }
    if (attempt + 1 < WORKER_CLOSE_MAX_ATTEMPTS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25 * 2 ** attempt);
      });
    }
  }
  return { cleanupWarnings: [...warnings], settled: outcome.settled };
}

export async function runReclamationWorkerPort(
  port: MessagePort,
  data: SqliteSessionReclamationWorkerData,
): Promise<void> {
  let result: ReturnType<typeof reclaimSqliteSessionInTransaction>;
  const commitGate = data.commitGate;
  try {
    let transactionDatabase: DatabaseSync | undefined;
    try {
      result = reclaimSqliteSessionInTransaction(data.plan, {
        onCommit: commitGate
          ? (database) => {
              transactionDatabase = database.db;
              waitForSqliteReclamationCommit(commitGate, () =>
                port.postMessage({ type: "commit-request" }),
              );
            }
          : undefined,
      });
    } finally {
      if (
        transactionDatabase &&
        (!transactionDatabase.isOpen || !transactionDatabase.isTransaction)
      ) {
        markSqliteReclamationSettled(commitGate);
      }
    }
  } catch (error) {
    const cleanup = await settleReclamationDatabase(data.plan.databaseOptions.path);
    if (cleanup.settled) {
      markSqliteReclamationSettled(commitGate);
    } else {
      throw new AggregateError(
        [error, ...cleanup.cleanupWarnings.map((warning) => new Error(warning))],
        "SQLite session reclamation failed and Worker cleanup is incomplete; restart OpenClaw before deleting the owning agent",
        { cause: error },
      );
    }
    throw error;
  }
  const cleanup = await settleReclamationDatabase(data.plan.databaseOptions.path);
  const workerResult: SqliteSessionReclamationWorkerResult = {
    result,
    ...(cleanup.cleanupWarnings.length > 0 ? { cleanupWarnings: cleanup.cleanupWarnings } : {}),
    ...(!cleanup.settled ? { cleanupIncomplete: true } : {}),
  };
  port.postMessage({ type: "reclaimed", results: [workerResult] });
  port.close();
}
