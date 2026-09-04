import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { toErrorObject } from "./errors.js";
import { installationTargetEnv } from "./installation-target-context.js";
import { runUpdateRepairLoop, type UpdateRepairValidation } from "./update-repair-agent.js";
import {
  UPDATE_REPAIR_IPC_MAX_BYTES,
  updateRepairParentMessageSchema,
  type UpdateRepairWorkerMessage,
} from "./update-repair-protocol.js";
import { getUpdateRun } from "./update-run-ledger.js";

const controller = new AbortController();
let started = false;
let requestId = 0;
let pending:
  | {
      id: number;
      resolve: (validation: UpdateRepairValidation) => void;
      reject: (error: Error) => void;
    }
  | undefined;

function send(message: UpdateRepairWorkerMessage, complete?: () => void): void {
  if (!process.connected || !process.send) {
    controller.abort(new Error("Repair orchestrator disconnected."));
    return;
  }
  if (Buffer.byteLength(JSON.stringify(message)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
    controller.abort(new Error("Repair response exceeded its bounded diagnostic budget."));
    return;
  }
  process.send(message, (error) => {
    if (error) {
      controller.abort(error);
    } else {
      complete?.();
    }
  });
}

process.once("disconnect", () => controller.abort(new Error("Repair orchestrator disconnected.")));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(new Error("Repair worker cancelled.")));
}
process.on("message", (raw: unknown) => {
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
      throw new Error("Repair request exceeded its bounded diagnostic budget.");
    }
    const message = updateRepairParentMessageSchema.parse(raw);
    if (message.type === "cancel") {
      controller.abort(new Error(message.reason));
    } else if (message.type === "validation-result" || message.type === "validation-error") {
      if (pending?.id === message.id) {
        if (message.type === "validation-result") {
          pending.resolve(message.validation);
        } else {
          pending.reject(new Error(message.reason));
        }
      }
    } else {
      if (started) {
        throw new Error("Repair worker already owns an execution.");
      }
      started = true;
      // Agent execution temporarily projects isolated state into process.env.
      // Run liveness must always read the admitting installation's ledger.
      const ledgerEnv = {
        ...process.env,
        ...installationTargetEnv({
          stateDir: message.target.stateDir,
          configPath: message.target.configPath,
          defaultWorkspaceDir: message.target.workspaceDir,
        }),
      };
      void runUpdateRepairLoop({
        target: message.target,
        context: { ...message.failure, ...message.context, phase: "verifying" },
        budget: message.budget,
        signal: controller.signal,
        isCurrent: () => {
          if (!process.connected || controller.signal.aborted) {
            return false;
          }
          if (!message.runId) {
            return true;
          }
          const run = getUpdateRun(message.runId, { env: ledgerEnv });
          return run?.status === "running" && run.phase === "repairing";
        },
        onEvent: (event) => send({ type: "event", event }),
        validate: (signal) =>
          new Promise<UpdateRepairValidation>((resolve, reject) => {
            signal.throwIfAborted();
            const id = ++requestId;
            const clear = () => {
              signal.removeEventListener("abort", abort);
              pending = undefined;
            };
            const abort = () => {
              clear();
              send({ type: "cancel-validation", id });
              reject(toErrorObject(signal.reason, "Repair validation cancelled."));
            };
            pending = {
              id,
              resolve: (validation) => {
                clear();
                resolve(validation);
              },
              reject: (error) => {
                clear();
                reject(error);
              },
            };
            signal.addEventListener("abort", abort, { once: true });
            send({ type: "validate", id });
          }),
      })
        .then((result) => {
          closeOpenClawStateDatabase();
          send({ type: "result", result }, () => process.exit(0));
        })
        .catch(() => process.exit(1));
    }
  } catch (error) {
    controller.abort(error);
    if (!started) {
      process.exit(1);
    }
  }
});
send({ type: "ready" });
