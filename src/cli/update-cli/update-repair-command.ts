import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
} from "../../config/config.js";
import { resolveGatewayPort } from "../../config/paths.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import {
  inspectUpdateRunAbandonment,
  isUnacknowledgedAbandonedUpdateRun,
} from "../../infra/update-run-activity.js";
import {
  acknowledgeAbandonedUpdateRun,
  listUpdateRuns,
  reconcileAbandonedUpdateRuns,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import {
  confirmGatewayReachable,
  resolveGatewayRestartProbeContext,
  waitForGatewayHttpReadiness,
} from "../daemon-cli/restart-health-probe.js";
import {
  parseTimeoutMsOrExit,
  resolveUpdateRoot,
  tryResolveInvocationCwd,
  type UpdateFinalizeOptions,
} from "./shared.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import { resolveServiceRefreshEnv } from "./update-command-service-env.js";

const POST_CORE_PHASES = new Set(["activating", "restarting", "verifying"]);

function needsPostCoreRepair(run: UpdateRunRecord): boolean {
  // Reconciliation finishes phase steps but does not prove post-core convergence.
  return (
    POST_CORE_PHASES.has(run.phase) ||
    run.steps.some(
      (step) =>
        POST_CORE_PHASES.has(step.step) ||
        step.step === "post-update verification" ||
        step.step.startsWith("finalize:"),
    )
  );
}

function inspectNewerRecoveryHistory(recoveryRuns: UpdateRunRecord[], env: NodeJS.ProcessEnv) {
  if (!recoveryRuns.length) {
    return { postCoreRuns: [], incomplete: false };
  }
  const oldestRecovery = Math.min(...recoveryRuns.map((run) => run.createdAtMs));
  const history = listUpdateRuns({ limit: 100 }, { env });
  const postCoreRuns = history.filter(
    (run) =>
      run.createdAtMs >= oldestRecovery &&
      run.status === "failed" &&
      run.reason === "abandoned" &&
      !run.steps.some((step) => step.step === "reconcile:acknowledged") &&
      needsPostCoreRepair(run),
  );
  // A bounded prefix cannot prove absence of interrupted work beyond its tail.
  const incomplete = history.length === 100 && (history.at(-1)?.createdAtMs ?? 0) >= oldestRecovery;
  return { postCoreRuns, incomplete };
}

function assertNoActiveDriver(runs: UpdateRunRecord[]): void {
  const active = runs.find((run) => !inspectUpdateRunAbandonment(run, { explicit: true }));
  if (active) {
    throw new Error(
      `Update ${active.runId} is still in progress (${active.phase}); its driver is live or abandonment is not established. Wait for that update before running update repair.`,
    );
  }
}

/** Public repair can clear a stale ledger without entering post-core maintenance. */
export async function updateRepairCommand(opts: UpdateFinalizeOptions): Promise<void> {
  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  if (timeoutMs === null) {
    return;
  }
  const env = resolveServiceRefreshEnv(process.env, tryResolveInvocationCwd());
  const options = { env };
  assertConfigWriteAllowedInCurrentMode({ env });
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(env),
    env,
    recoverOrphanedSidecars: false,
  });
  const activeRuns = listUpdateRuns({ active: true, limit: 100 }, options);
  assertNoActiveDriver(activeRuns);
  const lastRun = listUpdateRuns({ limit: 1 }, options)[0];
  const recoveryRuns = activeRuns.length
    ? activeRuns
    : lastRun && isUnacknowledgedAbandonedUpdateRun(lastRun)
      ? [lastRun]
      : [];
  const history = inspectNewerRecoveryHistory(recoveryRuns, env);
  const recoveryRunIds = [
    ...new Set([...recoveryRuns, ...history.postCoreRuns].map((run) => run.runId)),
  ];

  if (
    opts.channel !== undefined ||
    opts.acceptCapabilities ||
    recoveryRuns.length === 0 ||
    recoveryRuns.some(needsPostCoreRepair) ||
    history.postCoreRuns.length > 0 ||
    history.incomplete
  ) {
    await updateFinalizeCommand(opts, recoveryRunIds);
    return;
  }

  const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
  if (!snapshot.valid) {
    await updateFinalizeCommand(opts, recoveryRunIds);
    return;
  }
  const context = await resolveGatewayRestartProbeContext(env);
  const port = resolveGatewayPort(context.config, env);
  const root = await resolveUpdateRoot();
  const [gateway, http, expectedVersion, expectedBuildId] = await Promise.all([
    confirmGatewayReachable({ port, ...context, env }),
    waitForGatewayHttpReadiness({
      config: context.config,
      port,
      attempts: 1,
      deadlineAt: Date.now() + Math.min(timeoutMs ?? 3_000, 3_000),
      delayMs: 0,
    }),
    readPackageVersion(root),
    readBuiltGatewayBuildId(root),
  ]);
  // An old Gateway can remain healthy after the package changed on disk, before
  // the interrupted updater recorded any post-core work.
  if (
    !gateway.reachable ||
    !expectedVersion ||
    !expectedBuildId ||
    gateway.gatewayVersion !== expectedVersion ||
    gateway.gatewayBuildId !== expectedBuildId ||
    gateway.activatedPluginErrors.length ||
    gateway.channelProbeErrors.length ||
    http.healthz !== 200 ||
    http.readyz !== 200
  ) {
    await updateFinalizeCommand(opts, recoveryRunIds);
    return;
  }

  // Health probes await network I/O. Recheck current rows before the ledger's
  // transaction revalidates each captured run's inactivity and driver identity.
  assertConfigWriteAllowedInCurrentMode({ env });
  const currentRuns = listUpdateRuns({ active: true, limit: 100 }, options);
  assertNoActiveDriver(currentRuns);
  const currentHistory = inspectNewerRecoveryHistory(recoveryRuns, env);
  if (
    currentRuns.some(needsPostCoreRepair) ||
    currentHistory.postCoreRuns.length > 0 ||
    currentHistory.incomplete
  ) {
    throw new Error(
      "Update repair needs post-core maintenance. Stop the Gateway service through its owner before retrying; repair will not stop or restart it.",
    );
  }
  const reconciled = activeRuns.length
    ? reconcileAbandonedUpdateRuns(
        { explicit: true, runIds: activeRuns.map((run) => run.runId), requireAllActive: true },
        options,
      )
    : [];
  if (listUpdateRuns({ active: true, limit: 1 }, options).length) {
    throw new Error("An update is still in progress; retry update repair after it finishes.");
  }
  for (const runId of new Set([...recoveryRuns, ...reconciled].map((run) => run.runId))) {
    acknowledgeAbandonedUpdateRun(runId, options);
  }
  const message = reconciled.length
    ? `Gateway is healthy. Reconciled ${reconciled.length} abandoned update run${reconciled.length === 1 ? "" : "s"}. No maintenance or service restart was needed.`
    : "Gateway is healthy. Abandoned update runs are already reconciled. No maintenance or service restart was needed.";
  if (opts.json) {
    defaultRuntime.writeJson({
      status: "ok",
      mode: "repair",
      restart: false,
      reconciledRuns: reconciled.map((run) => run.runId),
      message,
    });
  } else {
    defaultRuntime.log(message);
  }
}
