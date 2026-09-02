// Worker-thread boundary for synchronous shadow-index publication.
/* oxlint-disable unicorn/require-post-message-target-origin -- Worker MessagePort has no target origin. */
import { parentPort, workerData } from "node:worker_threads";
import {
  closeMemoryDatabase,
  MemoryIndexRevisionConflictError,
  openMemoryDatabaseAtPath,
  publishMemoryDatabaseTables,
} from "./manager-db.js";

export type MemoryPublishWorkerInput = {
  databasePath: string;
  sourcePath: string;
  metaKey: string;
  expectedRevision: number;
  vectorExtensionPath?: string;
  vectorIndexComplete: boolean;
};

export type MemoryPublishWorkerResult =
  | { status: "ok"; revision: number }
  | { status: "failed"; code: "revision-conflict" | "failed"; error: string };

function isInput(value: unknown): value is MemoryPublishWorkerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const input = value as Partial<MemoryPublishWorkerInput>;
  return (
    typeof input.databasePath === "string" &&
    input.databasePath.length > 0 &&
    typeof input.sourcePath === "string" &&
    input.sourcePath.length > 0 &&
    typeof input.metaKey === "string" &&
    input.metaKey.length > 0 &&
    typeof input.expectedRevision === "number" &&
    Number.isSafeInteger(input.expectedRevision) &&
    (input.vectorExtensionPath === undefined || typeof input.vectorExtensionPath === "string") &&
    typeof input.vectorIndexComplete === "boolean"
  );
}

async function run(input: unknown): Promise<MemoryPublishWorkerResult> {
  if (!isInput(input)) {
    return { status: "failed", code: "failed", error: "invalid memory publish worker input" };
  }
  const db = openMemoryDatabaseAtPath(input.databasePath, true);
  try {
    const revision = await publishMemoryDatabaseTables({
      targetDb: db,
      sourcePath: input.sourcePath,
      metaKey: input.metaKey,
      expectedRevision: input.expectedRevision,
      vectorExtensionPath: input.vectorExtensionPath,
      vectorIndexComplete: input.vectorIndexComplete,
    });
    return { status: "ok", revision };
  } catch (error) {
    return {
      status: "failed",
      code: error instanceof MemoryIndexRevisionConflictError ? "revision-conflict" : "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    closeMemoryDatabase(db);
  }
}

const publishPort = parentPort;
if (!publishPort) {
  throw new Error("memory publish worker requires a parent port");
}
void run(workerData).then(
  (result) => {
    publishPort.postMessage(result);
  },
  (error: unknown) => {
    const failure = {
      status: "failed",
      code: "failed",
      error: error instanceof Error ? error.message : String(error),
    } satisfies MemoryPublishWorkerResult;
    publishPort.postMessage(failure);
  },
);
