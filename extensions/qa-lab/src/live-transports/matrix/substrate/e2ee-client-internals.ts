import fs from "node:fs/promises";
import path from "node:path";
import type { MatrixQaObservedEvent } from "./events.js";

export type MatrixQaE2eeActorId = "driver" | "observer" | `driver-${string}` | `cli-${string}`;

export const MATRIX_QA_E2EE_SYNC_FILTER = {
  room: {
    ephemeral: { not_types: ["m.receipt"] },
  },
};

export function shouldRecordMatrixQaObservedEventUpdate(params: {
  next: MatrixQaObservedEvent;
  previous: MatrixQaObservedEvent | undefined;
}) {
  const previous = params.previous;
  if (!previous) {
    return true;
  }
  const next = params.next;
  return (
    (previous.body === undefined && next.body !== undefined) ||
    (previous.formattedBody === undefined && next.formattedBody !== undefined) ||
    (previous.msgtype === undefined && next.msgtype !== undefined) ||
    (previous.mentions === undefined && next.mentions !== undefined) ||
    (previous.attachment === undefined && next.attachment !== undefined)
  );
}

function buildMatrixQaE2eeStoragePaths(params: {
  actorId: MatrixQaE2eeActorId;
  outputDir: string;
  scenarioId: string;
}) {
  const rootDir = path.join(params.outputDir, "matrix-e2ee", "accounts", params.actorId);
  const accountDir = path.join(rootDir, "account");
  const runKey = path
    .basename(params.outputDir)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(-80);
  const actorKey = params.actorId.replace(/[^A-Za-z0-9_-]/g, "-").slice(-40);
  return {
    accountDir,
    cryptoDatabasePrefix: `qa-lab-matrix-${runKey || "run"}-${actorKey || "actor"}`,
    idbSnapshotPath: path.join(accountDir, "crypto-idb-snapshot.json"),
    recoveryKeyPath: path.join(accountDir, "recovery-key.json"),
    rootDir,
    storagePath: path.join(accountDir, "sync-store.json"),
  };
}

export async function prepareMatrixQaE2eeStorage(params: {
  actorId: MatrixQaE2eeActorId;
  outputDir: string;
  scenarioId: string;
}) {
  const storage = buildMatrixQaE2eeStoragePaths(params);
  await fs.mkdir(storage.rootDir, { mode: 0o700, recursive: true });
  await fs.mkdir(storage.accountDir, { mode: 0o700, recursive: true });
  await fs.chmod(storage.rootDir, 0o700);
  await fs.chmod(storage.accountDir, 0o700);
  await fs
    .writeFile(storage.idbSnapshotPath, "[]\n", { flag: "wx", mode: 0o600 })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    });
  await fs.chmod(storage.idbSnapshotPath, 0o600);
  return storage;
}
