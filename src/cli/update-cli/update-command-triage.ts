import { randomUUID } from "node:crypto";
import { triageAfterFailure } from "../../commands/triage-failure.js";
import {
  sanitizeTriageUpdateFailure,
  writeTriageUpdateFailure,
} from "../../commands/triage-update.js";
import { resolveStateDir } from "../../config/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readControlPlaneUpdateSentinelMeta } from "../../infra/update-control-plane-sentinel.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { UpdateTriageTarget as TriageTarget } from "../../infra/update-triage.js";
import { defaultRuntime } from "../../runtime.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { isTerminalInteractive } from "../terminal-interactivity.js";
import { resolveNodeRunner, resolveUpdateRoot, type UpdateCommandOptions } from "./shared.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { runInteractiveUpdateFailureAction } from "./update-command-report.js";
import { UpdateCommandFailure } from "./update-command-result.js";

export type UpdateTriageTarget = TriageTarget & { failureResult?: UpdateRunResult };

export async function withUpdateFailureTriage(
  opts: Pick<UpdateCommandOptions, "json" | "yes" | "dryRun" | "run"> & { invocationCwd?: string },
  target: UpdateTriageTarget,
  run: () => Promise<void>,
): Promise<void> {
  // CLI and Gateway reports for an admitted run share its identity and state scope.
  // Standalone calls without an admitted run still own a fresh attempt.
  const updateAttemptId = opts.run?.runId ?? randomUUID();
  const mode = opts.json
    ? "json"
    : !opts.yes && isTerminalInteractive()
      ? "interactive"
      : "non-interactive";
  const { prepareUpdateFailureTriage } = await import("../../infra/update-triage.js");
  const runTriage = await prepareUpdateFailureTriage({
    mode,
    runtime: {
      ...defaultRuntime,
      log: opts.json ? defaultRuntime.error : defaultRuntime.log,
    },
    invocationCwd: opts.invocationCwd,
  });
  try {
    await run();
  } catch (error) {
    const reportedFailure = error instanceof UpdateCommandFailure;
    // Post-core children return phase data; only their outer updater owns the final failure.
    if (
      (!reportedFailure || classifyUpdateOutcome(error.result) === "failed") &&
      !opts.dryRun &&
      target.env[POST_CORE_UPDATE_ENV] !== "1"
    ) {
      const failure = reportedFailure
        ? { result: error.result, ...(error.detail ? { error: error.detail } : {}) }
        : {
            ...(target.failureResult ? { result: target.failureResult } : {}),
            error: formatErrorMessage(error),
          };
      const automatic =
        mode !== "interactive" && reportedFailure ? error.automaticTriage : undefined;
      if (automatic || target.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1") {
        let updateResultPath: string | undefined;
        try {
          const meta = await readControlPlaneUpdateSentinelMeta(target.env);
          if (!automatic && !meta?.triageContextPath) {
            throw new Error("Managed update triage context path is unavailable.", { cause: error });
          }
          updateResultPath = await writeTriageUpdateFailure(failure, {
            env: target.env,
            ...(meta?.triageContextPath ? { outputPath: meta.triageContextPath } : {}),
          });
        } catch (exportError) {
          const diagnostic = sanitizeTriageUpdateFailure(
            { error: formatErrorMessage(exportError) },
            { env: target.env, stateDir: resolveStateDir(target.env) },
          );
          defaultRuntime.error(
            `${automatic ? "Update" : "Managed update"} failure diagnostics could not be saved: ${diagnostic.error}`,
          );
        }
        // Finalization records eligibility. The outer owner starts one repair only
        // after locks and service compensation unwind; otherwise the helper owns diagnostics.
        if (automatic) {
          await withOwnedManagedUpdateEnv(target.env, () =>
            triageAfterFailure(defaultRuntime, automatic, undefined, updateResultPath),
          );
        }
      } else {
        let nextAction: "triage" | "handled" = "triage";
        if (mode === "interactive") {
          try {
            nextAction = await runInteractiveUpdateFailureAction({
              attemptId: updateAttemptId,
              env: opts.run?.env ?? target.env,
              ...(failure.error ? { error: failure.error } : {}),
              ...(failure.result ? { result: failure.result } : {}),
              runtime: defaultRuntime,
            });
          } catch (reportError) {
            defaultRuntime.error(
              `Update failure report could not be prepared: ${formatErrorMessage(reportError)}`,
            );
            nextAction = "handled";
          }
        }
        if (nextAction === "triage") {
          await runTriage({
            failure,
            target:
              mode === "interactive"
                ? target
                : { ...target, nodeRunner: target.nodeRunner ?? resolveNodeRunner() },
            resolveRoot: resolveUpdateRoot,
          });
        }
      }
    }
    if (reportedFailure) {
      exitCliAfterOutput(defaultRuntime, error.exitCode);
    }
    throw error;
  }
}
