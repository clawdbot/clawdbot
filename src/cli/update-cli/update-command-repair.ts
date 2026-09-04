import { sanitizeTriageUpdateFailure } from "../../commands/triage-update.js";
import { resolveInstallationTarget } from "../../infra/installation-target-context.js";
import {
  prepareUnattendedUpdateRepair,
  type UpdateRepairEvent,
  type UpdateRepairValidation,
} from "../../infra/update-repair-agent.js";
import {
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunRepairAttempt,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";

export async function runUpdateCommandRepair(params: {
  root: string;
  candidateRoot?: string;
  env: NodeJS.ProcessEnv;
  run?: UpdateCommandOptions["run"];
  result: UpdateRunResult;
  phase: "validating" | "verifying";
  nodeRunner?: string;
  validate: (signal: AbortSignal, assertCurrent: () => void) => Promise<UpdateRepairValidation>;
  onEvent?: (event: UpdateRepairEvent) => void;
}) {
  const target = resolveInstallationTarget(params.env);
  const options = {
    env: params.run?.env ?? params.env,
    redactPaths: [params.root, ...(params.candidateRoot ? [params.candidateRoot] : [])],
  };
  const runId = params.run?.runId;
  const isCurrent = () => !runId || getUpdateRun(runId, options)?.status === "running";
  const previousAttempts = runId ? (getUpdateRun(runId, options)?.repair ?? []) : [];
  const attemptOffset = Math.max(0, ...previousAttempts.map((attempt) => attempt.attempt));
  const startedAtMs = Date.now();
  let turnStartedAtMs = startedAtMs;
  let completedTurns = 0;
  if (runId) {
    recordUpdateRunPhase(runId, "repairing", undefined, options);
  }
  return await withOwnedManagedUpdateEnv(params.env, async () => {
    let pending: Promise<UpdateRepairValidation> | undefined;
    try {
      return await prepareUnattendedUpdateRepair({
        runId,
        nodeRunner: params.nodeRunner,
        target: {
          installRoot: params.root,
          candidateRoot: params.candidateRoot,
          stateDir: target.stateDir,
          configPath: target.configPath,
          workspaceDir: target.defaultWorkspaceDir,
        },
        context: {
          ...sanitizeTriageUpdateFailure(
            { result: params.result },
            { env: params.env, stateDir: target.stateDir },
          ),
          phase: params.phase,
          beforeVersion: params.result.before?.version ?? undefined,
          targetVersion: params.result.after?.version ?? undefined,
        },
        validate: (signal) => {
          const assertCurrent = () => {
            signal.throwIfAborted();
            if (!isCurrent()) {
              throw new Error("Repair no longer owns the update attempt.");
            }
          };
          assertCurrent();
          pending = params.validate(signal, assertCurrent);
          return pending;
        },
        isCurrent,
        onEvent: (event) => {
          if (event.type === "turn-started") {
            turnStartedAtMs = Date.now();
          }
          if (runId) {
            if (event.type === "turn-started" || event.type === "turn-finished") {
              recordUpdateRunStep(
                runId,
                {
                  step: `repair attempt ${attemptOffset + event.turn}`,
                  status:
                    event.type === "turn-started"
                      ? "in_progress"
                      : event.validation.ok
                        ? "completed"
                        : "failed",
                  startedAtMs: turnStartedAtMs,
                  ...(event.type === "turn-finished"
                    ? { endedAtMs: Date.now(), detail: event.summary }
                    : {}),
                },
                options,
              );
            }
            if (event.type === "turn-finished") {
              completedTurns += 1;
              recordUpdateRunRepairAttempt(
                runId,
                {
                  attempt: attemptOffset + event.turn,
                  status: event.validation.ok ? "succeeded" : "failed",
                  startedAtMs: turnStartedAtMs,
                  endedAtMs: Date.now(),
                  summary: `${event.provider}/${event.model}: ${event.summary}`,
                  reason: event.validation.summary,
                },
                options,
              );
            }
            if (event.type === "stopped") {
              recordUpdateRunStep(
                runId,
                {
                  step: "repairing",
                  status: event.status === "repaired" ? "completed" : "failed",
                  endedAtMs: Date.now(),
                  detail: event.reason ?? event.status,
                },
                options,
              );
              if (completedTurns === 0) {
                recordUpdateRunRepairAttempt(
                  runId,
                  {
                    attempt: attemptOffset + 1,
                    status: event.status === "repaired" ? "succeeded" : "skipped",
                    startedAtMs,
                    endedAtMs: Date.now(),
                    summary: event.reason ?? event.status,
                  },
                  options,
                );
              }
            }
          }
          params.onEvent?.(event);
        },
      });
    } finally {
      // Cancellation must drain the oracle before its caller activates or discards
      // a candidate, or restores the installation environment.
      await pending?.catch(() => undefined);
    }
  });
}
