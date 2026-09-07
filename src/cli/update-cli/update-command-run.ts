import { isDeepStrictEqual } from "node:util";
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
import {
  createUpdateRun,
  finishInterruptedUpdatePreviewInTransaction,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import {
  summarizeUpdateStepFailure,
  type UpdateRunRecord,
  type UpdateRunStep,
} from "../../infra/update-run-record.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { readRecoveries } from "../../infra/update-run-recovery-store.js";
import { inspectUpdateRecoveries, loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import type { UpdateRunResult, UpdateStepProgress } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { VERSION } from "../../version.js";
import { registerSignalExitBarrier, waitForSignalExitBarriers } from "../signal-exit-barrier.js";
import { parseUpdateTimeoutMs, resolveUpdateRoot, type UpdateCommandOptions } from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import {
  admitMutableUpdateSignalRun,
  withMutableUpdateSignals,
} from "./update-command-mutable-signals.js";
import {
  resolveOwnedManagedUpdateEnv,
  resolveServiceRefreshEnv,
} from "./update-command-service-env.js";
import {
  GatewayServiceUpdateOwnershipError,
  gatewayServiceCommandUsesRoot,
  isGatewayServiceManagementAllowedForUpdate,
  resolveManagedServicePackageUpdatePlan,
} from "./update-command-service-plan.js";

// Identity in this map is minted only for a new local preview, never reconstructed
// from a run ID, process absence, or another invocation's diagnostic history.
const previewAdmissions = new WeakMap<
  object,
  { record: UpdateRunRecord; env: NodeJS.ProcessEnv }
>();

export async function resolveUpdateCommandAdmissionEnv(params: {
  opts: UpdateCommandOptions;
  root: string;
  invocationCwd?: string;
}): Promise<NodeJS.ProcessEnv> {
  let env = resolveServiceRefreshEnv(process.env, params.invocationCwd);
  // A preview belongs to its explicit state directory. Real updates follow the
  // same owned service selectors as finalization, then freeze them for all writers.
  if (
    !params.opts.dryRun &&
    !env[UPDATE_RUN_ID_ENV] &&
    isGatewayServiceManagementAllowedForUpdate(env)
  ) {
    // Admission must not load native units or turn unavailable ownership into
    // an absent service and a write to the caller's unrelated profile.
    const command = await resolveGatewayService()
      .readCommand(env, {
        requireEffective: true,
        requireLoaded: true,
      })
      .catch((cause: unknown) => {
        throw new GatewayServiceUpdateOwnershipError(
          "Gateway service inspection is unavailable before update admission. Run `openclaw gateway status --deep` from the service's owning account and retry when service access is restored.",
          cause,
        );
      });
    if (command) {
      const usesRoot = await gatewayServiceCommandUsesRoot({ root: params.root, command });
      if (usesRoot === null) {
        throw new GatewayServiceUpdateOwnershipError(
          "Gateway service package ownership could not be resolved before update admission; inspect the service from its owning account and retry.",
          undefined,
        );
      }
      if (usesRoot) {
        env = resolveOwnedManagedUpdateEnv({
          processEnv: env,
          serviceEnv: mergeGatewayServiceEnv(env, command),
          serviceDefinitionEnv: resolveManagedGatewayServiceCommand(command)?.environment,
          invocationCwd: params.invocationCwd,
        });
      }
    }
  }
  return env;
}

export async function admitUpdateCommandRun(params: {
  opts: UpdateCommandOptions;
  root: string;
  invocationCwd?: string;
}): Promise<NonNullable<UpdateCommandOptions["run"]>> {
  const env = await resolveUpdateCommandAdmissionEnv(params);
  // A previous invocation may have died with a sealed restoration plan. Detect
  // it before any writable owner open or history row creation changes that state.
  // An inherited diagnostic run ID is not a durable continuation claim.
  await assertUpdateRecoveryAdmission({ env });
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(env),
    env,
    recoverOrphanedSidecars: false,
  });
  const record = createUpdateRun(
    {
      runId: env[UPDATE_RUN_ID_ENV]?.trim() || undefined,
      trigger: "cli",
      target: { channel: params.opts.channel, tag: params.opts.tag },
      before: { version: VERSION },
    },
    { env },
  );
  const requester = resolveManagedUpdateRequester(record.origin.requester);
  const requesterAuthority = requester
    ? await createManagedUpdateRequesterAuthority(requester, env)
    : undefined;
  const run = { runId: record.runId, env, ...(requesterAuthority ? { requesterAuthority } : {}) };
  if (
    !env[UPDATE_RUN_ID_ENV] &&
    env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1" &&
    env[POST_CORE_UPDATE_ENV] !== "1"
  ) {
    if (params.opts.dryRun === true) {
      previewAdmissions.set(run, { record, env: { ...env } });
    } else {
      admitMutableUpdateSignalRun(run, record);
    }
  }
  return run;
}

/** Own diagnostics only for this freshly admitted invocation's lexical lifetime. */
export async function withUpdatePreviewSignals<T>(
  opts: UpdateCommandOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const admission = opts.dryRun === true && opts.run ? previewAdmissions.get(opts.run) : undefined;
  if (!admission || !opts.run) {
    return await withMutableUpdateSignals(opts, operation);
  }
  previewAdmissions.delete(opts.run);
  const { record: expected, env } = admission;
  let interrupted = false;
  let shutdown: Promise<void> | undefined;
  const unregister = registerSignalExitBarrier(async () => {
    if (
      !interrupted ||
      process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" ||
      process.env[POST_CORE_UPDATE_ENV] === "1"
    ) {
      return;
    }
    // Missing/displaced canonical state, pending recovery, or a changed row is
    // not permission to open a writable runtime or dispose of another owner.
    await assertUpdateRecoveryAdmission({ env });
    if (!isDeepStrictEqual(getUpdateRun(expected.runId, { env }), expected)) {
      return;
    }
    runOpenClawStateWriteTransaction(
      (database) => {
        const options = { env, database };
        if (
          readRecoveries(database.db).some(
            (entry) => entry.runId === expected.runId || !entry.terminal,
          )
        ) {
          return;
        }
        finishInterruptedUpdatePreviewInTransaction(database.db, expected, options);
      },
      { env },
    );
  });
  const onSignal = (code: number) => {
    interrupted = true;
    shutdown ??= waitForSignalExitBarriers()
      .catch(() => {
        defaultRuntime.error(
          "Preview interruption could not be recorded; history remains pending.",
        );
      })
      .finally(() => process.exit(code));
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await operation();
  } finally {
    await shutdown;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    unregister();
  }
}

export function failUpdateCommandRun(
  error: unknown,
  run: NonNullable<UpdateCommandOptions["run"]>,
): void {
  const options = { env: run.env };
  // Recovery owns failure/outcome publication; outer unwind must not rewrite a
  // database whose exact contents may still be needed to reconcile restoration.
  if (loadUpdateRecovery(run.runId, options)) {
    return;
  }
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
  // A process-local result cannot complete an operationally pending update or
  // authorize package retirement. Only the durable finalizer may close it.
  const inspected = inspectUpdateRecoveries({ env: run.env }).find(
    (entry) => entry.record.runId === run.runId,
  );
  // A matching historical record can only project its saved outcome or remain
  // pending below. The mutable fallback still uses strict execution admission;
  // unrelated legacy evidence must not become an absent/clean recovery state.
  const recovery =
    inspected?.format === "legacy-serving"
      ? inspected.record
      : loadUpdateRecovery(run.runId, { env: run.env });
  if (
    recovery?.terminal &&
    getUpdateRun(run.runId, { env: run.env })?.status === recovery.terminal.status
  ) {
    // Read the atomic durable outcome; diagnostics never authorize retention cleanup.
    return {
      ...result,
      status: recovery.terminal.status === "succeeded" ? "ok" : "error",
      reason:
        recovery.terminal.status === "succeeded"
          ? undefined
          : (recovery.primaryFailure?.code ?? "update-rolled-back"),
      runId: run.runId,
    };
  }
  if (recovery) {
    return {
      ...result,
      status: "error",
      reason: result.reason ?? "update-recovery-pending",
      runId: run.runId,
    };
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
