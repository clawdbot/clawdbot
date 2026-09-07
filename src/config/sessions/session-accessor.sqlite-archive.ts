import path from "node:path";
import { Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";

export type SessionStateDeletePlan = {
  agentId: string;
  archiveDirectory: string;
  archiveTranscript: boolean;
  databasePath: string;
  reason: "deleted" | "reset";
  sessionId: string;
  snapshot: SessionStateDeleteSnapshot;
};

export type MaterializedSessionStateDeletePlan = SessionStateDeletePlan & {
  archive: MaterializedSessionTranscriptArchive | null;
  archivedTranscript: SessionLifecycleArchivedTranscript | null;
};

type MaterializedSessionTranscriptArchive = {
  archiveName: string;
  bytes: Uint8Array;
  createdAt: number;
  encoding: "identity" | "zstd";
  sha256: string;
};

export type TranscriptArchiveWorkerPlan = Pick<
  SessionStateDeletePlan,
  "agentId" | "archiveDirectory" | "databasePath" | "reason" | "sessionId" | "snapshot"
>;

export type TranscriptArchiveWorkerResult = {
  archive: MaterializedSessionTranscriptArchive | null;
  sessionId: string;
};

export type TranscriptArchiveWorkerMessage = {
  type: "done";
  results: TranscriptArchiveWorkerResult[];
};

export type TranscriptArchivePublishPlan = {
  agentId: string;
  archiveDirectory: string;
  databasePath: string;
  generation: string;
  sessionId: string;
};

export type TranscriptArchivePublishResult = {
  archivedPath?: string;
  error?: string;
  generation: string;
  sessionId: string;
};

export type TranscriptArchivePublishWorkerMessage = {
  type: "published";
  results: TranscriptArchivePublishResult[];
};

function resolveSourceWorkerExecArgv(): string[] {
  // Node 22 can strip the .ts entrypoint itself, but `--import tsx` does not
  // register tsx's ESM resolver inside a Worker. Explicitly register the
  // supported programmatic API so source-tree .js specifiers map back to .ts.
  // Built .js workers do not use this development/test-only preload.
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  const registerTsx = `import { register } from ${JSON.stringify(tsxApiUrl)}; register();`;
  return ["--import", `data:text/javascript,${encodeURIComponent(registerTsx)}`];
}

function spawnSqliteTranscriptArchiveWorkerOperation<Result>(params: {
  diagnostics?: { workerThreadId?: number };
  expectedMessageType: "done" | "published" | "reclaimed";
  onCommitRequest?: () => void;
  transferList?: ArrayBuffer[];
  workerData: object;
}): Promise<Result[]> {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptArchive);
  let worker: Worker;
  try {
    const sourceWorkerExecArgv = workerUrl.pathname.endsWith(".ts")
      ? resolveSourceWorkerExecArgv()
      : undefined;
    worker = new Worker(workerUrl, {
      workerData: params.workerData,
      execArgv: sourceWorkerExecArgv,
      transferList: params.transferList,
    });
    // Node clears threadId at exit. Keep only the spawned identity for the awaiting writer.
    if (params.diagnostics) {
      params.diagnostics.workerThreadId = worker.threadId;
    }
  } catch (error) {
    return Promise.reject(toStringifiedError(error));
  }

  return new Promise((resolve, reject) => {
    let results: Result[] | undefined;
    let workerError: Error | undefined;
    worker.on("message", (message: { results: Result[]; type: string }) => {
      if (message.type === "commit-request") {
        try {
          params.onCommitRequest?.();
        } catch (error) {
          workerError = toStringifiedError(error);
        }
      } else if (message.type === params.expectedMessageType) {
        (results ??= []).push(...message.results);
      }
    });
    worker.once("error", (error) => {
      // An uncaught Worker error is followed by exit. Wait for that event so
      // callers never race the Worker's SQLite/file handles on Windows.
      workerError ??= toStringifiedError(error);
    });
    worker.once("exit", (code) => {
      worker.removeAllListeners();
      if (workerError) {
        reject(workerError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`SQLite transcript archive worker exited with code ${code}`));
        return;
      }
      if (!results) {
        reject(new Error("SQLite transcript archive worker exited without results"));
        return;
      }
      resolve(results);
    });
  });
}

// Serialize lifecycle archive Workers so this path cannot multiply
// whole-buffer usage across several Worker heaps at once.
const sqliteTranscriptArchiveWorkerQueue = new KeyedAsyncQueue();
const SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY = "lifecycle-archive";

export function runSqliteTranscriptArchiveWorkerOperation<Result>(params: {
  diagnostics?: { workerThreadId?: number };
  expectedMessageType: "done" | "published" | "reclaimed";
  onCommitRequest?: () => void;
  transferList?: ArrayBuffer[];
  workerData: object;
}): Promise<Result[]> {
  return sqliteTranscriptArchiveWorkerQueue.enqueue(
    SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY,
    () => spawnSqliteTranscriptArchiveWorkerOperation<Result>(params),
  );
}

function runSqliteTranscriptArchiveWorker(
  plans: readonly TranscriptArchiveWorkerPlan[],
): Promise<TranscriptArchiveWorkerResult[]> {
  return runSqliteTranscriptArchiveWorkerOperation<TranscriptArchiveWorkerResult>({
    expectedMessageType: "done",
    workerData: { operation: "materialize", type: "sqlite-transcript-archive-v2", plans },
  });
}

export function runSqliteTranscriptArchivePublishWorker(
  plans: readonly TranscriptArchivePublishPlan[],
): Promise<TranscriptArchivePublishResult[]> {
  return runSqliteTranscriptArchiveWorkerOperation<TranscriptArchivePublishResult>({
    expectedMessageType: "published",
    workerData: { operation: "publish", type: "sqlite-transcript-archive-v2", plans },
  });
}

function validateEmptyTranscriptArchivePlan(plan: TranscriptArchiveWorkerPlan): void {
  const opened = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionStateDeleteSnapshot(database.db, plan.sessionId),
    { agentId: plan.agentId, path: plan.databasePath },
  );
  if (!opened.found) {
    throw new Error(
      `Cannot archive SQLite transcript ${plan.sessionId}: ${opened.reason.replaceAll("-", " ")}`,
    );
  }
  if (!sqliteSessionStateDeleteSnapshotsEqual(opened.value, plan.snapshot)) {
    throw new Error(
      `SQLite session state changed before archive materialization for ${plan.sessionId}`,
    );
  }
}

// Reads and encodes one consistent generation outside SQLite write transactions
// and off the gateway event loop. The lifecycle Worker queue and per-call
// dedupe prevent concurrent whole-buffer spikes within this path.
export async function materializeSessionStateDeletePlans(
  plans: readonly SessionStateDeletePlan[],
): Promise<MaterializedSessionStateDeletePlan[]> {
  const deduped = dedupeSqliteSessionStateDeletePlans(plans);
  const workerResults: TranscriptArchiveWorkerResult[] = [];
  const workerPlans: TranscriptArchiveWorkerPlan[] = [];
  for (const archivePlan of deduped.filter((plan) => plan.archiveTranscript)) {
    if (archivePlan.snapshot.lastSeq === null) {
      // Empty transcripts still need a fresh snapshot fence, but have no bytes
      // to encode off-thread and should not pay Worker startup latency.
      validateEmptyTranscriptArchivePlan(archivePlan);
      workerResults.push({ archive: null, sessionId: archivePlan.sessionId });
      continue;
    }
    workerPlans.push(archivePlan);
  }
  if (workerPlans.length > 0) {
    workerResults.push(...(await runSqliteTranscriptArchiveWorker(workerPlans)));
  }
  const resultBySessionId = new Map(workerResults.map((result) => [result.sessionId, result]));

  return deduped.map((plan) => {
    if (!plan.archiveTranscript) {
      return Object.assign({}, plan, { archive: null, archivedTranscript: null });
    }
    const result = resultBySessionId.get(plan.sessionId);
    if (!result) {
      throw new Error(`SQLite transcript archive worker omitted ${plan.sessionId}`);
    }
    const generation = plan.snapshot.generation;
    if (result.archive && !generation) {
      throw new Error(
        `Cannot archive SQLite transcript without a generation for ${plan.sessionId}`,
      );
    }
    const archivedTranscript =
      result.archive && generation
        ? {
            generation,
            sessionId: plan.sessionId,
            archivedPath: path.join(plan.archiveDirectory, result.archive.archiveName),
            sourcePath: path.join(plan.archiveDirectory, `${plan.sessionId}.jsonl`),
          }
        : null;
    return Object.assign({}, plan, { archive: result.archive, archivedTranscript });
  });
}

// Multiple removed entries can point at one transcript session. If any owner
// asked to keep an archive, the shared row gets exported once.
function dedupeSqliteSessionStateDeletePlans(
  plans: readonly SessionStateDeletePlan[],
): SessionStateDeletePlan[] {
  const deduped = new Map<string, SessionStateDeletePlan>();
  for (const plan of plans) {
    const existing = deduped.get(plan.sessionId);
    if (!existing) {
      deduped.set(plan.sessionId, plan);
      continue;
    }
    if (
      existing.agentId !== plan.agentId ||
      existing.archiveDirectory !== plan.archiveDirectory ||
      existing.databasePath !== plan.databasePath ||
      existing.reason !== plan.reason ||
      !sqliteSessionStateDeleteSnapshotsEqual(existing.snapshot, plan.snapshot)
    ) {
      throw new Error(`Conflicting SQLite transcript archive plans for ${plan.sessionId}`);
    }
    if (!existing.archiveTranscript && plan.archiveTranscript) {
      deduped.set(plan.sessionId, { ...existing, archiveTranscript: true });
    }
  }
  return [...deduped.values()];
}
