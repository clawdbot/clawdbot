import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../../config/future-version-guard.js";
import {
  hashConfigRaw,
  normalizeConfigIoDeps,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
} from "../../config/io.read-helpers.js";
import { withConfigMutationLock } from "../../config/mutate.js";
import { resolveStateDir } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import { replaceFileAtomic } from "../../infra/replace-file.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
  updateStateSchemaVersionsMatch,
  type UpdateStateSchemaVersion,
} from "../../infra/update-candidate-state.js";
import { NativePackageRollbackError } from "../../infra/update-native-package-stage.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { confirmGatewayReachable } from "../daemon-cli/restart-health-probe.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  readUpdateConfigSnapshot,
  type UpdateConfigSnapshot,
} from "./update-command-config-snapshot.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { readPackageUpdateIdentity } from "./update-command-package.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import { createWindowsTaskAutoStartGuard } from "./update-command-service-maintenance.js";
import {
  maybeRestartService,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  resolveUpdatedGatewayRestartPort,
  type PreManagedServiceStop,
} from "./update-command-service.js";

/** Restores the previous generation only while schemas and activation-owned config stay intact. */
export async function rollbackFailedUpdate(params: {
  result: UpdateRunResult;
  previousRoot: string;
  packageTransaction?: PackageUpdateTransaction;
  rollbackBlockedReason?: "state-migrated-no-rollback" | "rollback-state-unverified";
  schemaVersions?: UpdateStateSchemaVersion[];
  candidateSchemaVersions?: OpenClawSchemaVersions;
  previousSchemaVersions?: OpenClawSchemaVersions;
  previousVerified?: boolean;
  configSnapshot: ConfigFileSnapshot;
  activationConfig?: UpdateConfigSnapshot;
  opts: UpdateCommandOptions;
  preManagedServiceStop?: PreManagedServiceStop;
  timeoutMs: number;
  nodeRunner?: string;
  invocationCwd?: string;
}): Promise<{
  result: UpdateRunResult;
  rolledBack: boolean;
  stoppedForRollback?: PreManagedServiceStop;
  verifiedAtMs?: number;
}> {
  const { preManagedServiceStop: before, packageTransaction, opts } = params;
  let result = params.result;
  const config =
    params.configSnapshot.sourceConfigBeforeMigrations ?? params.configSnapshot.sourceConfig;
  const configSnapshot = params.activationConfig ?? {
    path: params.configSnapshot.path,
    raw: params.configSnapshot.raw,
    hash: hashConfigRaw(params.configSnapshot.raw),
  };
  const env = before?.serviceEnv ?? opts.run?.env ?? process.env;
  const recoveryEnv = { ...env, [ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]: "1" };
  const port = before?.stopped
    ? await resolveUpdatedGatewayRestartPort({ config, serviceEnv: env })
    : undefined;
  const failed = (reason: string) => ({
    result: {
      ...result,
      status: "error" as const,
      reason:
        result.recovery?.serviceRestartSafe === true && result.recovery.packageRollbackVerified
          ? (params.result.reason ?? reason)
          : reason,
    },
    rolledBack: false,
    stoppedForRollback,
  });
  const stateUnchanged = async () => {
    const baseline = params.schemaVersions;
    const current = await readUpdateStateSchemaVersions({
      stateDir: resolveStateDir(env),
      config,
      env,
      root: result.root ?? null,
      nodeRunner: params.nodeRunner,
    });
    const sharedPath = resolveOpenClawStateSqlitePath(env);
    if (
      baseline === undefined ||
      !updateStateSchemaVersionsMatch(baseline, current, {
        sharedPath,
        candidateSchemaVersions: params.candidateSchemaVersions,
      })
    ) {
      return false;
    }
    const baselineVersions = new Map(
      baseline.map((entry) => [entry.path, resolveUpdateStateContentVersion(entry)]),
    );
    for (const entry of current) {
      const version = resolveUpdateStateContentVersion(entry);
      if (version === null || baselineVersions.get(entry.path) != null) {
        continue;
      }
      // First-use creation is not migration, but the retained runtime must still
      // support that new store before replacing a reachable candidate.
      const kind = entry.path === sharedPath ? "state" : "agent";
      const supported = params.previousSchemaVersions?.[kind];
      if (supported === undefined || version > supported) {
        throw new Error(
          `Automatic rollback refused: newly created ${kind} database ${entry.path} uses schema ${version}; retained previous package support is ${supported ?? "unknown"}. Keep the candidate installed.`,
        );
      }
    }
    await assertConfigUnchanged();
    return true;
  };
  let stoppedForRollback: PreManagedServiceStop | undefined;
  let failureReason = "rollback-state-unverified";
  const assertConfigUnchanged = async () => {
    let unchanged =
      params.activationConfig?.doctorOwned !== false &&
      (await readUpdateConfigSnapshot(configSnapshot.path)).hash === configSnapshot.hash;
    if (unchanged && params.configSnapshot.includedPaths?.length) {
      // Only the root file is restored. Resolve its captured include graph so
      // edits to separate config files cannot escape the original state guard.
      const deps = normalizeConfigIoDeps({ env: { ...env } });
      const included = resolveConfigIncludesForRead(
        params.configSnapshot.parsed,
        params.configSnapshot.path,
        deps,
      );
      unchanged = isDeepStrictEqual(
        config,
        resolveConfigForRead(included, deps.env).resolvedConfigRaw,
      );
    }
    if (!unchanged) {
      failureReason = "state-migrated-no-rollback";
      const detail = `Configuration ${configSnapshot.path} or its included files changed after activation; automatic rollback was refused to preserve those edits.`;
      result = {
        ...result,
        steps: [
          ...result.steps,
          {
            name: "config rollback",
            command: "restore pre-update config",
            cwd: params.previousRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: detail,
          },
        ],
      };
      throw new Error(detail);
    }
  };
  const stop = async () => {
    failureReason = "service-revalidation-failed";
    // The parent binary can be older than the candidate's stamp even before bytes are restored.
    // This existing recovery allowance belongs only to this guarded stop invocation.
    const stopped = await withOwnedManagedUpdateEnv(recoveryEnv, () =>
      maybeStopManagedServiceBeforeMutableUpdate({
        updateRun: opts.run,
        updateInstallKind: "package",
        root: result.root ?? params.previousRoot,
        shouldRestart: true,
        jsonMode: opts.json === true,
        expectedService: before,
        timeoutMs: params.timeoutMs,
      }),
    );
    if (stopped.serviceEnv) {
      stopped.serviceEnv = { ...stopped.serviceEnv };
      delete stopped.serviceEnv[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
    }
    // Reinspection of an already disabled task creates no new suspension owner.
    // Keep the original authority through rollback activation and final settlement.
    stopped.windowsTaskAutoStartRecovery ??= before?.windowsTaskAutoStartRecovery;
    stoppedForRollback = stopped;
    if (
      stopped.blockMessage ||
      stopped.serviceMutationAllowed === false ||
      (stopped.running && !stopped.stopped)
    ) {
      throw new Error(stopped.blockMessage ?? "Candidate service could not be stopped safely.");
    }
    return stopped;
  };
  const stopIfUnreachable = async () => {
    if (port !== undefined && !(await confirmGatewayReachable({ port, env })).reachable) {
      await stop();
    }
  };
  try {
    if (params.rollbackBlockedReason) {
      await stopIfUnreachable();
      return failed(params.rollbackBlockedReason);
    }
    if (!params.schemaVersions) {
      await stopIfUnreachable();
      return failed("rollback-state-unverified");
    }
    if (!(await stateUnchanged())) {
      await stopIfUnreachable();
      return failed("state-migrated-no-rollback");
    }
    await packageTransaction?.assertRollbackSafe?.();
    const stopped = before?.stopped ? await stop() : undefined;
    // Recheck after stop so a final startup migration cannot race the first read.
    failureReason = "rollback-state-unverified";
    if (!(await stateUnchanged())) {
      return failed("state-migrated-no-rollback");
    }
    failureReason = "source-rollback-failed";
    if (!packageTransaction) {
      throw new Error("The retained package transaction is unavailable.");
    }
    const { activePackageRoot, ...restored } = await packageTransaction.rollback();
    // Restoration changes the active runtime before any later reporting or
    // restart can fail. Carry that identity through every recovery outcome.
    result = {
      ...result,
      root: activePackageRoot ?? undefined,
      after: undefined,
      steps: [...result.steps, restored],
    };
    if (restored.exitCode === 0) {
      // The transaction verified the previous package. Do not gate its restart
      // on an extra diagnostic read whose result would be discarded.
      result.after = result.before;
      result.recovery = {
        serviceRestartSafe: false,
        packageRollbackVerified: true,
        reason: "runtime-verification-failed",
      };
    } else if (activePackageRoot) {
      result.after = await readPackageUpdateIdentity(activePackageRoot);
    }
    if (opts.run) {
      recordUpdateRunStep(
        opts.run.runId,
        {
          step: "package rollback",
          status: restored.exitCode === 0 ? "completed" : "failed",
          endedAtMs: Date.now(),
          ...(restored.reason ? { detail: restored.stderrTail ?? restored.reason } : {}),
        },
        { env: opts.run.env },
      );
    }
    if (restored.exitCode !== 0) {
      return failed(restored.reason ?? "source-rollback-failed");
    }
    failureReason = "rollback-state-unverified";
    if (configSnapshot.hash === hashConfigRaw(configSnapshot.raw)) {
      await assertConfigUnchanged();
    } else {
      await withOwnedManagedUpdateEnv(env, () =>
        withConfigMutationLock({ lockPath: configSnapshot.path }, async () => {
          await assertConfigUnchanged();
          if (configSnapshot.raw === null) {
            await fs.rm(configSnapshot.path, { force: true });
          } else {
            await replaceFileAtomic({
              filePath: configSnapshot.path,
              content: configSnapshot.raw,
              mode: 0o600,
              preserveExistingMode: false,
              beforeRename: assertConfigUnchanged,
            });
          }
        }),
      );
    }
    // A no-service or --no-restart update owns file restoration only. Preserve
    // its original failure without claiming or changing a Gateway generation.
    if (!stopped || port === undefined) {
      return { result, rolledBack: false };
    }
    if (!params.previousVerified || !result.before?.version) {
      // Restoring retained bytes is safe after the schema fence. Starting the
      // previous runtime additionally requires its pre-activation verification.
      return failed("previous-version-unverified");
    }
    failureReason = "service-revalidation-failed";
    await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
      stopped,
      true,
      createWindowsTaskAutoStartGuard({
        root: params.previousRoot,
        before: stopped,
        timeoutMs: params.timeoutMs,
      }),
    );
    // A failed candidate does not authorize its restart. The previous package's
    // pre-activation verification authorizes restarting this schema-neutral restoration.
    const verdict = stopped.serviceUpdateVerdict ?? before?.serviceUpdateVerdict;
    const nodeRunner = before?.serviceNodeRunner ?? params.nodeRunner;
    if (verdict?.kind === "owned" && verdict.refreshDefinition) {
      await runUpdatedInstallGatewayCommand(
        {
          result,
          opts,
          invocationEnv: env,
          serviceInstallEnv: before?.serviceDefinitionEnv,
          nodeRunner,
          timeoutMs: params.timeoutMs,
          invocationCwd: params.invocationCwd,
        },
        "install",
      );
    }
    result.recovery = {
      serviceRestartSafe: true,
      packageRollbackVerified: true,
      version: result.before.version,
      ...(result.before.buildId ? { buildId: result.before.buildId } : {}),
    };
    if (opts.run) {
      recordUpdateRunStep(
        opts.run.runId,
        {
          step: "previous generation restoration",
          status: "completed",
          endedAtMs: Date.now(),
        },
        { env: opts.run.env },
      );
    }
    failureReason = "restart-unhealthy";
    let verifiedAtMs: number | undefined;
    const restartOutcome = await maybeRestartService({
      shouldRestart: true,
      result,
      opts,
      refreshServiceEnv: false,
      serviceUpdateVerdict: verdict,
      serviceEnv: recoveryEnv,
      serviceInstallEnv: before?.serviceDefinitionEnv,
      gatewayPort: port,
      requireRunningServiceAfterRestart: true,
      timeoutMs: params.timeoutMs,
      // Prior verification covers this executable too; refreshing with the
      // candidate's newer Node would not restore the previously serving runtime.
      nodeRunner,
      invocationCwd: params.invocationCwd,
      onVerified: (at) => {
        verifiedAtMs = at;
      },
    });
    const healthy = restartOutcome === "ok";
    return {
      result: {
        ...result,
        recovery: healthy ? { ...result.recovery, service: "healthy" } : result.recovery,
      },
      rolledBack: healthy,
      stoppedForRollback,
      ...(verifiedAtMs === undefined ? {} : { verifiedAtMs }),
    };
  } catch (error) {
    let detail = formatErrorMessage(error);
    if (error instanceof NativePackageRollbackError) {
      failureReason = error.reason;
    }
    if (
      failureReason === "rollback-state-unverified" ||
      failureReason === "state-migrated-no-rollback" ||
      error instanceof NativePackageRollbackError
    ) {
      const reason = failureReason;
      try {
        await stopIfUnreachable();
        failureReason = reason;
      } catch (stopError) {
        detail += `; ${formatErrorMessage(stopError)}`;
      }
    }
    if (opts.run) {
      recordUpdateRunStep(
        opts.run.runId,
        {
          step: "package rollback",
          status: "failed",
          endedAtMs: Date.now(),
          detail,
        },
        { env: opts.run.env },
      );
    }
    return failed(failureReason);
  }
}
