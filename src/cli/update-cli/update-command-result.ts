// Update failures and control-plane results share one reporting boundary.
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  markControlPlaneUpdateRestartSentinelFailure,
  resolveManagedServiceUpdateFailureExitCode,
  writeControlPlaneUpdateRestartSentinel,
  type ControlPlaneUpdateSentinelMetaFile,
} from "../../infra/update-control-plane-sentinel.js";
import { verifyPackageUpdateRecovery } from "../../infra/update-global.js";
import { getUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { printResult } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

/** Unwind update ownership before diagnostics or an interactive agent can run. */
export class UpdateCommandFailure extends Error {
  constructor(
    readonly result: UpdateRunResult,
    readonly exitCode = 1,
    readonly detail?: string,
    options?: ErrorOptions,
  ) {
    super(detail ?? result.reason ?? "Update failed", options);
    this.name = "UpdateCommandFailure";
  }
}

export async function reportPreMutationUpdateFailure(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  reason: string;
  message?: string;
  opts: UpdateCommandOptions;
  controlPlaneUpdateSentinelMeta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
}): Promise<void> {
  const run = params.opts.run;
  const active = run ? getUpdateRun(run.runId, { env: run.env }) : undefined;
  if (run && active && params.message) {
    recordUpdateRunPhase(
      run.runId,
      active.phase,
      { origin: { nextAction: params.message } },
      { env: run.env },
    );
  }
  const result = completeUpdateCommandRun(
    {
      status: "error",
      mode: params.installKind === "git" ? "git" : "unknown",
      root: params.root,
      reason: params.reason,
      ...(params.opts.dryRun !== true
        ? {
            recovery: await (params.installKind === "git"
              ? readCurrentGitUpdateRecovery(params.root)
              : verifyPackageUpdateRecovery(params.root)),
          }
        : {}),
      steps: [],
      durationMs: 0,
    },
    params.opts.run,
  );
  if (params.opts.dryRun !== true) {
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result,
      jsonMode: Boolean(params.opts.json),
    });
  }
  if (params.opts.json && params.message) {
    defaultRuntime.error(params.message);
  }
  printResult(result, params.opts, { nextAction: params.message });
  throw new UpdateCommandFailure(
    result,
    resolveManagedServiceUpdateFailureExitCode(result),
    params.message,
  );
}

export async function writeControlPlaneUpdateRestartSentinelBestEffort(params: {
  meta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
  result: UpdateRunResult;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.meta) {
    return;
  }
  try {
    await writeControlPlaneUpdateRestartSentinel({
      meta: params.meta,
      result: params.result,
    });
  } catch (err) {
    const message = `Failed to write update.run restart sentinel: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}

export async function markControlPlaneUpdateRestartSentinelFailureBestEffort(params: {
  meta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
  reason: string;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.meta) {
    return;
  }
  try {
    await markControlPlaneUpdateRestartSentinelFailure(params.reason);
  } catch (err) {
    const message = `Failed to mark update.run restart sentinel failed: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}
