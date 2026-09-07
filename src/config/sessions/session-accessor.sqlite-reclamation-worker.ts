import { isDeepStrictEqual } from "node:util";
import type { Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  borrowOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
} from "../../state/openclaw-agent-db.js";
import {
  createSqliteTranscriptArchiveWorker,
  runExclusiveSqliteTranscriptArchiveWorker,
} from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-reclamation.js";

type DatabaseOptions = SqliteSessionReclamationPlan["databaseOptions"];
export type SqliteReclamationWorkerRequest = {
  type: "reclaim";
  operationId: number;
  commitGate: SharedArrayBuffer;
  plan: SqliteSessionReclamationPlan;
};
type WorkerCleanup = { cleanupWarnings: string[]; settled: boolean };
export type SqliteReclamationWorkerMessage =
  | { type: "commit-request"; operationId: number }
  | { type: "reclaimed"; operationId: number; result: SqliteSessionReclamationResult }
  | ({ type: "closed" } & WorkerCleanup);

const log = createSubsystemLogger("sessions/reclamation");

/** One lazy sweep-owned connection; each request keeps its own transaction and live authority. */
export class SqliteReclamationWorker {
  private owner?: {
    options: DatabaseOptions;
    borrowed: ReturnType<typeof borrowOpenClawAgentDatabase>;
  };
  private worker?: Worker;
  private workerThreadId?: number;
  private exited?: Promise<void>;
  private failure?: Error;
  private reportedFailure?: Error;
  private cleanup?: WorkerCleanup;
  private closing?: Promise<void>;
  private operationId = 0;

  assertCurrent(options: DatabaseOptions): void {
    if (this.failure) {
      this.reportedFailure = this.failure;
      throw this.failure;
    }
    if (this.closing) {
      throw new Error("SQLite session reclamation scope is closed");
    }
    const owner = this.owner;
    if (
      owner &&
      (!isDeepStrictEqual(owner.options, options) ||
        !owner.borrowed.db.isOpen ||
        getOpenClawAgentDatabaseIfOpen(options)?.db !== owner.borrowed.db)
    ) {
      throw new Error("SQLite session reclamation database owner is no longer current");
    }
  }

  run(params: {
    diagnostics?: SqliteSessionReclamationDiagnostics;
    plan: SqliteSessionReclamationPlan;
    assertCommitAllowed?: () => void;
    transferList: ArrayBuffer[];
  }): Promise<SqliteSessionReclamationResult> {
    // The queue preserves this request's async context, not the first Worker's caller.
    return runExclusiveSqliteTranscriptArchiveWorker(async () => {
      const options = params.plan.databaseOptions;
      this.assertCurrent(options);
      if (!this.owner) {
        this.owner = {
          options: structuredClone(options),
          borrowed: borrowOpenClawAgentDatabase(options),
        };
      }
      this.worker ??= this.start(this.owner.options);
      const worker = this.worker;
      if (params.diagnostics) {
        params.diagnostics.workerThreadId = this.workerThreadId;
      }
      const operationId = ++this.operationId;
      const commitGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      return await withSqliteReclamationAuthorization(
        commitGate,
        this.owner.borrowed.db,
        () => {
          this.assertCurrent(options);
          params.assertCommitAllowed?.();
          this.assertCurrent(options);
        },
        async (authorize) => {
          let authorizationError: Error | undefined;
          const result = new Promise<SqliteSessionReclamationResult>((resolve, reject) => {
            const receive = (message: SqliteReclamationWorkerMessage) => {
              if (message.type === "closed" || message.operationId !== operationId) {
                return;
              }
              if (message.type === "commit-request") {
                try {
                  const errors = authorize();
                  if (errors.length) {
                    log.warn("SQLite session reclamation recovered commit settlement errors", {
                      errors: errors.map(String),
                      path: options.path,
                    });
                  }
                } catch (error) {
                  authorizationError = toStringifiedError(error);
                }
              } else if (!authorizationError) {
                worker.off("message", receive);
                worker.off("exit", exit);
                resolve(message.result);
              }
            };
            const exit = () => {
              worker.off("message", receive);
              this.failure =
                authorizationError ??
                this.failure ??
                new Error("SQLite session reclamation Worker exited without results");
              this.reportedFailure = this.failure;
              reject(this.failure);
            };
            worker.on("message", receive);
            worker.once("exit", exit);
            try {
              worker.postMessage(
                {
                  type: "reclaim",
                  operationId,
                  commitGate,
                  plan: params.plan,
                } satisfies SqliteReclamationWorkerRequest,
                params.transferList,
              );
            } catch (error) {
              this.failure = toStringifiedError(error);
              // An uncertain dispatch is terminal; never replay it on another Worker.
              void worker.terminate();
            }
          });
          return await result;
        },
      );
    });
  }

  private start(databaseOptions: DatabaseOptions): Worker {
    const worker = createSqliteTranscriptArchiveWorker({
      type: "sqlite-transcript-archive-v2",
      operation: "reclaim",
      databaseOptions,
    });
    // Node clears threadId on exit; every request retains this spawned identity.
    this.workerThreadId = worker.threadId;
    worker.on("message", (message: SqliteReclamationWorkerMessage) => {
      if (message.type === "closed") {
        this.cleanup = message;
      }
    });
    worker.once("error", (error) => {
      // Errors are followed by exit; do not release caller authority before the join.
      this.failure ??= toStringifiedError(error);
    });
    worker.once("messageerror", (error) => {
      this.failure ??= toStringifiedError(error);
      void worker.terminate();
    });
    this.exited = new Promise((resolve) => {
      worker.once("exit", (code) => {
        if (code !== 0 || !this.closing || !this.cleanup) {
          this.failure ??= new Error(
            `SQLite session reclamation Worker exited with code ${code} without completing its lifetime; outcome is uncertain, restart OpenClaw before deleting the owning agent`,
          );
        }
        resolve();
      });
    });
    return worker;
  }

  close(): Promise<void> {
    const owner = this.owner;
    if (!owner) {
      // A lazy scope has no resources to join; queued requests will observe its closure.
      return (this.closing ??= Promise.resolve());
    }
    // Revoke immediately, then join behind every admitted request on the existing queue.
    return (this.closing ??= runExclusiveSqliteTranscriptArchiveWorker(async () => {
      try {
        this.worker?.postMessage({ type: "close" });
        await this.exited;
        // A failed request already reports its terminal outcome. Disposal must not hide it.
        if (this.failure && this.failure !== this.reportedFailure) {
          throw this.failure;
        }
        if (this.cleanup && !this.cleanup.settled) {
          log.error("SQLite session reclamation committed but Worker cleanup is incomplete", {
            errors: this.cleanup.cleanupWarnings,
            path: owner.options.path,
            recovery: "restart OpenClaw before deleting the owning agent",
          });
        } else if (this.cleanup?.cleanupWarnings.length) {
          log.warn("SQLite session reclamation Worker recovered cleanup failures", {
            errors: this.cleanup.cleanupWarnings,
            path: owner.options.path,
          });
        }
      } finally {
        owner.borrowed.release();
      }
    }));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
