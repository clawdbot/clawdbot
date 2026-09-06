import { spawn } from "node:child_process";
import path from "node:path";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { createCommandTerminationController } from "../process/exec-termination.js";
import { installationTargetEnv } from "./installation-target-context.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import {
  UPDATE_REPAIR_IPC_MAX_BYTES,
  updateRepairBudgetSchema,
  updateRepairParentMessageSchema,
  updateRepairWorkerMessageSchema,
  type UpdateRepairParentMessage,
  type UpdateRepairParams,
  type UpdateRepairResult,
  type UpdateRepairValidation,
} from "./update-repair-protocol.js";

/** Loaded before replacement; inference imports belong entirely to the candidate child. */
export async function runUpdateRepairWorker(
  params: UpdateRepairParams,
): Promise<UpdateRepairResult> {
  const attempts: UpdateRepairResult["attempts"] = [];
  let finalValidation: UpdateRepairValidation = {
    ok: false,
    score: 0,
    summary: "Candidate repair worker did not validate the installation.",
  };
  const clean = (value: unknown) =>
    redactSupportString(
      value instanceof Error ? value.message : String(value),
      { env: process.env, stateDir: params.target.stateDir },
      { maxLength: 1024 },
    );
  const stopped = (status: "unavailable" | "aborted", reason: string): UpdateRepairResult => {
    params.onEvent?.({ type: "stopped", status, reason });
    return { status, attempts, finalValidation, reason };
  };
  if (params.isCurrent && !params.runId) {
    return stopped(
      "unavailable",
      "Candidate repair requires the admitting update run identity to preserve its execution guard.",
    );
  }
  const parsedBudget = updateRepairBudgetSchema.safeParse(params.budget ?? {});
  if (!parsedBudget.success) {
    return stopped("aborted", "Invalid repair budget.");
  }
  const budget = parsedBudget.data;
  const deadline = Date.now() + budget.wallClockMs;
  const controller = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([controller.signal, params.signal])
    : controller.signal;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (params.isCurrent?.() === false) {
      throw new Error("Repair no longer owns the update attempt.");
    }
  };
  try {
    assertCurrent();
  } catch (error) {
    return stopped("aborted", clean(error));
  }
  const timer = setTimeout(
    () => controller.abort(new Error("wall-clock-budget")),
    budget.wallClockMs,
  );
  const env = {
    ...process.env,
    NODE_DISABLE_COMPILE_CACHE: "1",
    ...installationTargetEnv({
      stateDir: params.target.stateDir,
      configPath: params.target.configPath,
      defaultWorkspaceDir: params.target.workspaceDir,
    }),
  };
  let child;
  try {
    child = spawn(
      params.nodeRunner ?? process.execPath,
      [
        path.join(
          params.target.installRoot,
          "dist",
          runtimeProcessEntrypoints.updateRepair.distWorkerPath,
        ),
      ],
      {
        cwd: params.target.installRoot,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
  } catch (error) {
    clearTimeout(timer);
    return stopped("unavailable", clean(error));
  }
  let childExited = false;
  let commandSettled = false;
  let result: UpdateRepairResult | undefined;
  let failure: string | undefined;
  let stopping = false;
  let started = false;
  let requestId = 0;
  let pending: { id: number; controller: AbortController; promise: Promise<void> } | undefined;
  const cancelController = new AbortController();
  const termination = createCommandTerminationController({
    child,
    cancelController,
    env,
    processTree: { mode: "graceful" },
    killGraceMs: 1_000,
    isChildExited: () => childExited,
    isCommandSettled: () => commandSettled,
  });
  cancelController.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  const stop = (error: unknown) => {
    if (stopping) {
      return;
    }
    stopping = true;
    failure ??= clean(error);
    pending?.controller.abort(error);
    if (!termination.terminate()) {
      cancelController.abort();
    }
  };
  const send = (message: UpdateRepairParentMessage) => {
    if (!child.connected) {
      stop(new Error("Candidate repair worker closed its control channel."));
      return;
    }
    if (Buffer.byteLength(JSON.stringify(message)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
      stop(new Error("Candidate repair message exceeded its bounded diagnostic budget."));
      return;
    }
    child.send(message, (error) => {
      if (error) {
        stop(error);
      }
    });
  };
  const onAbort = () => {
    if (child.connected) {
      send({ type: "cancel", reason: clean(signal.reason) });
    }
    stop(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  child.on("message", (raw: unknown) => {
    if (stopping) {
      return;
    }
    try {
      assertCurrent();
      if (Buffer.byteLength(JSON.stringify(raw)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
        throw new Error("Candidate repair response exceeded its bounded diagnostic budget.");
      }
      const message = updateRepairWorkerMessageSchema.parse(raw);
      if (message.type === "ready") {
        if (started) {
          throw new Error("Candidate repair worker repeated startup.");
        }
        started = true;
        const {
          phase: _phase,
          beforeVersion,
          targetVersion,
          symptoms,
          ...failureContext
        } = params.context;
        const start = updateRepairParentMessageSchema.parse({
          type: "start",
          runId: params.runId,
          requester: params.requester,
          target: params.target,
          failure: failureContext,
          context: { beforeVersion, targetVersion, symptoms },
          budget: { ...budget, wallClockMs: Math.max(1, deadline - Date.now()) },
        });
        send(start);
      } else if (message.type === "validate") {
        if (!started || pending || message.id !== ++requestId || requestId > budget.maxTurns + 1) {
          throw new Error("Candidate repair validation request is outside its active turn.");
        }
        const validationController = new AbortController();
        const validationSignal = AbortSignal.any([signal, validationController.signal]);
        const promise = Promise.resolve().then(async () => {
          try {
            assertCurrent();
            const validation = await params.validate(validationSignal);
            validationSignal.throwIfAborted();
            assertCurrent();
            finalValidation = { ...validation, summary: clean(validation.summary) };
            send({ type: "validation-result", id: message.id, validation: finalValidation });
          } catch (error) {
            if (!signal.aborted && child.connected) {
              send({ type: "validation-error", id: message.id, reason: clean(error) });
            }
          } finally {
            pending = undefined;
          }
        });
        pending = { id: message.id, controller: validationController, promise };
      } else if (message.type === "cancel-validation") {
        if (pending?.id === message.id) {
          pending.controller.abort(new Error("Candidate repair validation was cancelled."));
        }
      } else if (message.type === "event") {
        if (
          (message.event.type === "turn-started" || message.event.type === "turn-finished") &&
          message.event.turn > budget.maxTurns
        ) {
          throw new Error("Candidate repair exceeded its turn budget.");
        }
        if (message.event.type === "turn-finished") {
          if (attempts.length >= budget.maxTurns || message.event.turn !== attempts.length + 1) {
            throw new Error("Candidate repair repeated a completed turn.");
          }
          const { type: _type, ...attempt } = message.event;
          attempts.push(attempt);
        }
        params.onEvent?.(message.event);
      } else {
        if (message.result.attempts.length > budget.maxTurns) {
          throw new Error("Candidate repair exceeded its turn budget.");
        }
        result = message.result;
      }
    } catch (error) {
      stop(error);
    }
  });
  child.once("disconnect", () => {
    if (!result) {
      stop(new Error("Candidate repair worker closed its control channel."));
    }
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      failure ??= clean(error);
    });
    child.once("exit", () => {
      childExited = true;
    });
    child.once("close", (code) => {
      commandSettled = true;
      resolve(code);
    });
  });
  try {
    const code = await closed;
    pending?.controller.abort(new Error("Candidate repair worker exited."));
    await pending?.promise;
    await termination.settle();
    assertCurrent();
    return result && code === 0 && !failure
      ? result
      : stopped(
          "unavailable",
          failure ??
            "Candidate repair worker exited without a result. Inspect the candidate installation with triage.",
        );
  } catch (error) {
    return stopped("aborted", clean(error));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
