import { assertConfigWriteAllowedInCurrentMode } from "../../config/config.js";
import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { resolveManagedGatewayServiceCommand } from "../../daemon/service-types.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  formatExternalSupervisorUpdateRequired,
  isGatewayExternallySupervised,
} from "../../infra/gateway-supervision.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import {
  readControlPlaneUpdateSentinelMeta,
  UPDATE_RUN_ID_ENV,
} from "../../infra/update-control-plane-sentinel.js";
import {
  parseDevUpdateTargetEnv,
  type DevUpdateTarget,
  UPDATE_DEV_TARGET_REF_ENV,
} from "../../infra/update-dev-target.js";
import { updateInstallRootsMatch } from "../../infra/update-install-root.js";
import {
  POST_CORE_UPDATE_CHANNEL_ENV,
  POST_CORE_UPDATE_ENV,
} from "../../infra/update-post-core-context.js";
import {
  createManagedUpdateRequesterAuthority,
  resolveManagedUpdateRequester,
} from "../../infra/update-requester-authority.js";
import { normalizeControlPlaneUpdateResult } from "../../infra/update-restart-sentinel-payload.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  heartbeatUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { summarizeUpdateStepFailure, type UpdateRunStep } from "../../infra/update-run-record.js";
import type { UpdateRunResult, UpdateStepProgress } from "../../infra/update-runner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { VERSION } from "../../version.js";
import { parseUpdateTimeoutMs, resolveUpdateRoot, type UpdateCommandOptions } from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import {
  resolveOwnedManagedUpdateEnv,
  resolveServiceRefreshEnv,
} from "./update-command-service-env.js";
import {
  gatewayServiceCommandUsesRoot,
  isGatewayServiceManagementAllowedForUpdate,
  resolveManagedServicePackageUpdatePlan,
} from "./update-command-service-plan.js";

export async function admitUpdateCommandRun(params: {
  opts: UpdateCommandOptions;
  root: string;
  invocationCwd?: string;
}): Promise<NonNullable<UpdateCommandOptions["run"]>> {
  let env = resolveServiceRefreshEnv(process.env, params.invocationCwd);
  // A preview belongs to its explicit state directory. Real updates follow the
  // same owned service selectors as finalization, then freeze them for all writers.
  if (
    !params.opts.dryRun &&
    !env[UPDATE_RUN_ID_ENV] &&
    isGatewayServiceManagementAllowedForUpdate(env)
  ) {
    const command = await resolveGatewayService()
      .readCommand(env, { requireEffective: true })
      .catch(() => null);
    if (command && (await gatewayServiceCommandUsesRoot({ root: params.root, command }))) {
      env = resolveOwnedManagedUpdateEnv({
        processEnv: env,
        serviceEnv: mergeGatewayServiceEnv(env, command),
        serviceDefinitionEnv: resolveManagedGatewayServiceCommand(command)?.environment,
        invocationCwd: params.invocationCwd,
      });
    }
  }
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(env),
    env,
    recoverOrphanedSidecars: false,
  });
  const driver = readUpdateRunDriver();
  const created = createUpdateRun(
    {
      runId: env[UPDATE_RUN_ID_ENV]?.trim() || undefined,
      trigger: "cli",
      origin: { driver },
      supersedeStaleIdentityless:
        !env[UPDATE_RUN_ID_ENV]?.trim() && env[POST_CORE_UPDATE_ENV] !== "1",
      target: { channel: params.opts.channel, tag: params.opts.tag },
      before: { version: VERSION },
    },
    { env },
  );
  const record = adoptUpdateRun(created.runId, { env });
  const requester = resolveManagedUpdateRequester(record.origin.requester);
  const requesterAuthority = requester
    ? await createManagedUpdateRequesterAuthority(requester, env)
    : undefined;
  return { runId: record.runId, env, ...(requesterAuthority ? { requesterAuthority } : {}) };
}

export function failUpdateCommandRun(
  error: unknown,
  run: NonNullable<UpdateCommandOptions["run"]>,
): void {
  const options = { env: run.env };
  const active = getUpdateRun(run.runId, options);
  if (active?.status !== "running") {
    return;
  }
  recordUpdateRunStep(
    run.runId,
    { step: active.phase, status: "failed", detail: formatErrorMessage(error) },
    options,
  );
  finishUpdateRun(run.runId, { status: "failed", reason: "update-failed" }, options);
}

export function createUpdateRunProgress(
  run: NonNullable<UpdateCommandOptions["run"]>,
  progress: UpdateStepProgress,
): UpdateStepProgress & {
  deferLedgerWrites: () => void;
  flushLedgerWrites: () => void;
  pendingSteps: UpdateRunStep[];
} {
  let deferred = false;
  const driver = readUpdateRunDriver();
  const pendingSteps: UpdateRunStep[] = [];
  const record = (step: UpdateRunStep) => {
    if (deferred) {
      pendingSteps.push(step);
    } else {
      recordUpdateRunStep(run.runId, step, { env: run.env });
    }
  };
  return {
    pendingSteps,
    onHeartbeat() {
      if (!deferred) {
        heartbeatUpdateRun(run.runId, driver, { env: run.env });
      }
    },
    deferLedgerWrites() {
      // Candidate Doctor can advance SQLite beyond this process's reader. Hold
      // activation receipts until the supported runtime owns ledger writes.
      deferred = true;
    },
    flushLedgerWrites() {
      deferred = false;
      for (const step of pendingSteps.splice(0)) {
        record(step);
      }
    },
    onStepStart(step) {
      record({ step: step.name, status: "in_progress", startedAtMs: Date.now() });
      progress.onStepStart?.(step);
    },
    onStepComplete(step) {
      const endedAtMs = Date.now();
      record({
        step: step.name,
        status: step.exitCode === 0 || step.advisory ? "completed" : "failed",
        startedAtMs: Math.max(0, endedAtMs - step.durationMs),
        endedAtMs,
        ...(step.exitCode !== 0
          ? { detail: step.advisory?.message ?? summarizeUpdateStepFailure(step) }
          : {}),
      });
      progress.onStepComplete?.(step);
    },
  };
}

export function completeUpdateCommandRun(
  result: UpdateRunResult,
  run: UpdateCommandOptions["run"],
  downtimeMs?: number,
): UpdateRunResult {
  if (!run) {
    return result;
  }
  const normalized = normalizeControlPlaneUpdateResult({ ...result, runId: run.runId });
  const recordOptions = { env: run.env, redactPaths: result.root ? [result.root] : [] };
  const active = getUpdateRun(run.runId, recordOptions);
  if (active) {
    recordUpdateRunPhase(
      run.runId,
      active.phase,
      { before: result.before, after: result.after },
      recordOptions,
    );
  }
  for (const step of result.steps) {
    recordUpdateRunStep(
      run.runId,
      {
        step: step.name,
        status: step.exitCode === 0 || step.advisory ? "completed" : "failed",
        ...(step.exitCode !== 0
          ? { detail: step.advisory?.message ?? summarizeUpdateStepFailure(step) }
          : {}),
      },
      recordOptions,
    );
  }
  // Both finalization and outer CLI unwind come here. A verified restored generation
  // stays with its helper until native recovery finishes; neither caller may close it early.
  const helperRecoveryPending =
    process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" &&
    result.recovery?.serviceRestartSafe === true &&
    result.recovery.packageRollbackVerified === true &&
    result.recovery.service === undefined;
  if (!helperRecoveryPending) {
    finishUpdateRun(
      run.runId,
      {
        status:
          normalized.status === "ok"
            ? "succeeded"
            : normalized.status === "error"
              ? "failed"
              : "skipped",
        reason: normalized.reason,
        after: normalized.after,
        downtimeMs,
      },
      recordOptions,
    );
  }
  return { ...result, runId: run.runId };
}

export function readDevUpdateTarget(): DevUpdateTarget | undefined {
  const parsed = parseDevUpdateTargetEnv(process.env);
  if (parsed.status === "invalid") {
    throw new Error(
      `Invalid internal ${UPDATE_DEV_TARGET_REF_ENV} contract; expected a plain Git ref or a supported tracked-target encoding.`,
    );
  }
  return parsed.status === "valid" ? parsed.target : undefined;
}

export async function prepareUpdateCommand(opts: UpdateCommandOptions) {
  const startedAt = Date.now();
  suppressDeprecations();
  const postCoreUpdateResume = process.env[POST_CORE_UPDATE_ENV] === "1";
  const postCoreUpdateChannel = process.env[POST_CORE_UPDATE_CHANNEL_ENV]?.trim();

  const timeoutMs = parseUpdateTimeoutMs(opts.timeout);
  const shouldRestart = opts.restart !== false;
  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel !== undefined && !requestedChannel) {
    throw new Error(
      `--channel must be "stable", "extended-stable", "beta", or "dev" (got "${opts.channel}")`,
    );
  }
  let devTarget: DevUpdateTarget | undefined;
  if (requestedChannel === "dev") {
    devTarget = readDevUpdateTarget();
  }

  if (!postCoreUpdateResume && opts.dryRun !== true && isGatewayExternallySupervised()) {
    throw new Error(formatExternalSupervisorUpdateRequired());
  }
  if (opts.dryRun !== true) {
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
      recoverOrphanedSidecars: false,
    });
  }
  const controlPlaneUpdateSentinelMeta = await readControlPlaneUpdateSentinelMeta();
  const discoveredRoot = await resolveUpdateRoot();
  const handoffRoot = controlPlaneUpdateSentinelMeta?.root;
  if (handoffRoot && !updateInstallRootsMatch(handoffRoot, discoveredRoot)) {
    throw new Error(
      `Managed update handoff root mismatch: expected ${handoffRoot}, running from ${discoveredRoot}.`,
    );
  }
  const installKind = await resolveUpdateInstallKind(discoveredRoot);
  const servicePlan =
    installKind === "package"
      ? await resolveManagedServicePackageUpdatePlan({ root: discoveredRoot })
      : undefined;
  if (opts.dryRun !== true) {
    try {
      assertConfigWriteAllowedInCurrentMode();
    } catch (err) {
      await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
      throw err;
    }
  }
  return {
    startedAt,
    postCoreUpdateResume,
    postCoreUpdateChannel,
    timeoutMs,
    shouldRestart,
    requestedChannel,
    devTarget,
    controlPlaneUpdateSentinelMeta,
    discoveredRoot,
    installKind,
    servicePlan,
  };
}
