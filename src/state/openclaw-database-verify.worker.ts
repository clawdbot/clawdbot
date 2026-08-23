import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  assertSqliteIntegrity,
  isTerminalSqliteIntegrityError,
} from "../infra/sqlite-integrity.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";

const DATABASE_VERIFY_CHILD_ARG = "--openclaw-database-verify-child";

export type OpenClawDatabaseVerifyTarget = {
  path: string;
  kind: "agent" | "state";
  label: string;
};

export type OpenClawDatabaseVerifyResult = {
  path: string;
  ok: boolean;
  error?: string;
  terminal?: boolean;
};

function isVerifyTarget(value: unknown): value is OpenClawDatabaseVerifyTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const target = value as Record<string, unknown>;
  return (
    typeof target.path === "string" &&
    (target.kind === "agent" || target.kind === "state") &&
    typeof target.label === "string"
  );
}

function formatVerifyError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function verifyOpenClawDatabase(
  target: OpenClawDatabaseVerifyTarget,
): Promise<OpenClawDatabaseVerifyResult> {
  let cleanup: (() => boolean) | undefined;
  let database: import("node:sqlite").DatabaseSync | undefined;
  let result = await (async (): Promise<OpenClawDatabaseVerifyResult> => {
    try {
      const prepared = await prepareSqliteReadOnlyLocation(target.path);
      cleanup = prepared.cleanup;
      database = openNodeSqliteDatabase(prepared.location, {
        readOnly: true,
      });
      database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      assertSqliteIntegrity(database, target.label);
      return { path: target.path, ok: true };
    } catch (error) {
      const terminal = error instanceof Error && isTerminalSqliteIntegrityError(error);
      return {
        path: target.path,
        ok: false,
        error: formatVerifyError(error),
        terminal,
      };
    }
  })();
  try {
    database?.close();
  } catch (error) {
    if (result.ok) {
      result = {
        path: target.path,
        ok: false,
        error: formatVerifyError(error),
        terminal: false,
      };
    }
  } finally {
    cleanup?.();
  }
  return result;
}

/** Verify database files serially so large agent scans never compete for I/O. */
export async function verifyOpenClawDatabases(
  targets: readonly OpenClawDatabaseVerifyTarget[],
): Promise<OpenClawDatabaseVerifyResult[]> {
  const results: OpenClawDatabaseVerifyResult[] = [];
  for (const target of targets) {
    results.push(await verifyOpenClawDatabase(target));
  }
  return results;
}

// This module is also imported for its verifier function. Only the dedicated
// child may consume and disconnect the process-wide IPC channel.
const sendToParent =
  process.argv[2] === DATABASE_VERIFY_CHILD_ARG ? process.send?.bind(process) : undefined;
if (sendToParent) {
  process.once("message", (message: unknown) => {
    void (async () => {
      try {
        const targets = Array.isArray(message) ? message.filter(isVerifyTarget) : [];
        const results = await verifyOpenClawDatabases(targets);
        await new Promise<void>((resolve, reject) => {
          sendToParent(results, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      } catch {
        process.exitCode = 1;
      } finally {
        process.disconnect?.();
      }
    })();
  });
}
