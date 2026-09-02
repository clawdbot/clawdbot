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
import { UpdateCommandFailure } from "./update-command-result.js";

export type UpdateTriageTarget = TriageTarget & { failureResult?: UpdateRunResult };

export async function withUpdateFailureTriage(
  opts: Pick<UpdateCommandOptions, "json" | "yes" | "dryRun"> & { invocationCwd?: string },
  target: UpdateTriageTarget,
  run: () => Promise<void>,
): Promise<void> {
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
      if (target.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1") {
        // This code was loaded before replacement. The helper stays dependency-free
        // and starts installed triage only after its own recovery has settled.
        try {
          const meta = await readControlPlaneUpdateSentinelMeta(target.env);
          if (!meta?.triageContextPath) {
            throw new Error("Managed update triage context path is unavailable.", { cause: error });
          }
          await writeTriageUpdateFailure(failure, {
            env: target.env,
            outputPath: meta.triageContextPath,
          });
        } catch (exportError) {
          const diagnostic = sanitizeTriageUpdateFailure(
            { error: formatErrorMessage(exportError) },
            {
              env: target.env,
              stateDir: resolveStateDir(target.env),
            },
          );
          defaultRuntime.error(
            `Managed update failure diagnostics could not be saved: ${diagnostic.error}`,
          );
        }
      } else {
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
    if (reportedFailure) {
      exitCliAfterOutput(defaultRuntime, error.exitCode);
    }
    throw error;
  }
}
