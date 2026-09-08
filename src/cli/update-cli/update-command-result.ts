// Update failures and control-plane results share one reporting boundary.
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { TriageFailureContext } from "../../commands/triage-prompt.js";
import { formatErrorMessage } from "../../infra/errors.js";
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
import type { PreManagedServiceStop } from "./update-command-service-maintenance.js";

/** Unwind update ownership before diagnostics or an interactive agent can run. */
export class UpdateCommandFailure extends Error {
  readonly automaticTriage?: TriageFailureContext;

  constructor(
    readonly result: UpdateRunResult,
    readonly exitCode = 1,
    readonly detail?: string,
    options?: ErrorOptions & { automaticTriage?: TriageFailureContext },
  ) {
    super(detail ?? result.reason ?? "Update failed", options);
    this.name = "UpdateCommandFailure";
    this.automaticTriage = options?.automaticTriage;
  }
}

export function mergeWindowsTaskRecoveryFailure(
  failure: { error: unknown } | undefined,
  recoveryError: unknown,
): { error: unknown } {
  if (failure?.error instanceof UpdateCommandFailure) {
    // A rejected restore promise can be observed again during unwinding.
    // Keep the reported failure and never turn cleanup into safe-exit 80.
    return {
      error: new UpdateCommandFailure(
        { ...failure.error.result, status: "error" },
        1,
        `${failure.error.message}; Windows autostart recovery: ${formatErrorMessage(recoveryError)}`,
        { cause: recoveryError, automaticTriage: failure.error.automaticTriage },
      ),
    };
  }
  return {
    error: failure
      ? new AggregateError(
          [failure.error, recoveryError],
          `Update failed (${formatErrorMessage(failure.error)}) and Windows autostart recovery failed (${formatErrorMessage(recoveryError)})`,
          { cause: failure.error },
        )
      : recoveryError,
  };
}

export function resolveAutomaticUpdateTriage(
  result: UpdateRunResult,
  detail: string | undefined,
  params: {
    mutationStarted: boolean;
    root: string;
    installKindChanged: boolean;
    expectedVersion?: string;
    gateway: TriageFailureContext["gateway"];
    preManagedServiceStop?: Pick<PreManagedServiceStop, "serviceMutationAllowed">;
  },
): TriageFailureContext | undefined {
  // Triage follows a failed update, never a verified rollback: the restored
  // generation is serving, and an autonomous repair turn there is unwanted.
  const verifiedRollback =
    result.recovery?.serviceRestartSafe === true &&
    result.recovery.packageRollbackVerified === true &&
    result.recovery.service === "healthy";
  const eligible =
    !verifiedRollback &&
    (params.mutationStarted || result.reason === "restart-unhealthy") &&
    result.reason !== "service-revalidation-failed" &&
    !(
      result.recovery?.serviceRestartSafe === false &&
      result.recovery.reason === "rollback-checkout-dirty"
    ) &&
    !result.postUpdate?.plugins?.npm.outcomes.some(
      (outcome) => outcome.code === PLUGIN_CAPABILITY_CONSENT_REQUIRED,
    ) &&
    params.preManagedServiceStop?.serviceMutationAllowed !== false &&
    !result.steps.some((step) => step.termination === "signal");
  const failedStep = result.steps.find((step) => step.exitCode !== 0 && !step.advisory);
  const phase = result.reason ?? "update";
  return eligible
    ? {
        kind: "update",
        phase,
        error: detail ?? failedStep?.stderrTail ?? failedStep?.stdoutTail ?? phase,
        // Global exposure, not the candidate checkout, identifies a package-to-Git target.
        installationRoot:
          params.installKindChanged && result.mode === "git"
            ? params.root
            : (result.root ?? params.root),
        expectedVersion: params.expectedVersion ?? result.after?.version ?? undefined,
        gateway: params.gateway,
      }
    : undefined;
}

export async function reportPreMutationUpdateFailure(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  reason: string;
  message?: string;
  opts: UpdateCommandOptions;
  controlPlaneUpdateSentinelMeta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
}): Promise<never> {
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
