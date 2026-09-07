import { sanitizeTriageUpdateFailure } from "../../commands/triage-update.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveInstallationTarget } from "../../infra/installation-target-context.js";
import {
  prepareUpdateCandidateRehearsal,
  type UpdateCandidateRehearsal,
} from "../../infra/update-candidate-rehearsal.js";
import { prepareUnattendedUpdateRepair } from "../../infra/update-repair-agent.js";
import type {
  UpdateRepairEvent,
  UpdateRepairValidation,
} from "../../infra/update-repair-protocol.js";
import {
  resolveManagedUpdateRequester,
  UpdateRequesterRevokedError,
} from "../../infra/update-requester-authority.js";
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
  validate: (
    signal: AbortSignal,
    assertCurrent: () => void,
    rehearsal?: UpdateCandidateRehearsal,
  ) => Promise<UpdateRepairValidation>;
  onEvent?: (event: UpdateRepairEvent) => void;
}) {
  const target = resolveInstallationTarget(params.env);
  const options = {
    env: { ...(params.run?.env ?? params.env) },
    redactPaths: [params.root, ...(params.candidateRoot ? [params.candidateRoot] : [])],
  };
  const runId = params.run?.runId;
  const admittedRun = runId ? getUpdateRun(runId, options) : undefined;
  const requester = resolveManagedUpdateRequester(admittedRun?.origin.requester);
  const requesterAuthority = params.run?.requesterAuthority;
  const isCurrent = () => {
    if ((requester && !requesterAuthority) || requesterAuthority?.isCurrent() === false) {
      throw new UpdateRequesterRevokedError();
    }
    return !runId || getUpdateRun(runId, options)?.status === "running";
  };
  const previousAttempts = admittedRun?.repair ?? [];
  const attemptOffset = Math.max(0, ...previousAttempts.map((attempt) => attempt.attempt));
  const startedAtMs = Date.now();
  let turnStartedAtMs = startedAtMs;
  let completedTurns = 0;
  let activeTurn = 0;
  let lastValidation: UpdateRepairValidation | undefined;
  const targetClass = params.phase === "validating" ? "candidate rehearsal" : "live";
  if (runId) {
    recordUpdateRunPhase(
      runId,
      "repairing",
      { step: { step: "repairing", status: "in_progress", detail: targetClass } },
      options,
    );
  }
  return await withOwnedManagedUpdateEnv(params.env, async () => {
    let pending: Promise<UpdateRepairValidation> | undefined;
    let rehearsal: UpdateCandidateRehearsal | undefined;
    try {
      if (params.phase === "validating") {
        const snapshot = await readConfigFileSnapshot({
          // Plugin metadata reads SQLite; materialize it only after binding the rehearsal.
          pluginValidation: "core-only",
          observe: false,
        });
        rehearsal = await prepareUpdateCandidateRehearsal({
          config: snapshot.config,
          sourceConfigHash: snapshot.hash,
          stateDir: target.stateDir,
          env: params.env,
          nodeRunner: params.nodeRunner,
        });
      }
      return await prepareUnattendedUpdateRepair({
        runId,
        requester: requesterAuthority?.requester,
        nodeRunner: params.nodeRunner,
        target: {
          installRoot: params.root,
          candidateRoot: params.candidateRoot,
          stateDir: rehearsal?.stateDir ?? target.stateDir,
          configPath: rehearsal?.configPath ?? target.configPath,
          workspaceDir: rehearsal?.workspaceDir ?? target.defaultWorkspaceDir,
          environment: rehearsal?.env,
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
          pending = (async () => {
            const validation = await params.validate(signal, assertCurrent, rehearsal);
            assertCurrent();
            if (validation.ok && rehearsal) {
              const keys = await rehearsal.changedConfigKeys();
              assertCurrent();
              if (keys.length) {
                return {
                  ...validation,
                  ok: false,
                  stopReason: "repair-requires-config-change",
                  summary: `Config changes required in top-level keys: ${keys.join(", ")}. Copies were discarded; run openclaw doctor --fix under your own authority, or openclaw triage.`,
                };
              }
            }
            return validation;
          })();
          return pending;
        },
        isCurrent,
        onEvent: (event) => {
          if (event.type === "validation") {
            lastValidation = event.validation;
          }
          if (event.type === "turn-started") {
            turnStartedAtMs = Date.now();
            activeTurn = event.turn;
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
                  summary: `${event.provider}/${event.model}: ${event.validation.stopReason ? event.validation.summary : event.summary}`,
                  reason: event.validation.stopReason ?? event.validation.summary,
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
                  detail: `${targetClass}: ${event.reason ?? event.status}${lastValidation?.stopReason ? ` — ${lastValidation.summary}` : ""}`,
                },
                options,
              );
              if (completedTurns === 0 || event.reason === "requester-revoked") {
                recordUpdateRunRepairAttempt(
                  runId,
                  {
                    attempt: attemptOffset + Math.max(1, activeTurn),
                    status:
                      event.status === "repaired" ? "succeeded" : activeTurn ? "failed" : "skipped",
                    startedAtMs: activeTurn ? turnStartedAtMs : startedAtMs,
                    endedAtMs: Date.now(),
                    summary: lastValidation?.stopReason
                      ? lastValidation.summary
                      : (event.reason ?? event.status),
                    reason: event.reason,
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
      await rehearsal?.cleanup();
    }
  });
}
