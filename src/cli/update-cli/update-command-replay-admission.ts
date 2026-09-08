import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { resolveManagedGatewayServiceCommand } from "../../daemon/service-types.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { reopenPackageUpdateTransaction } from "../../infra/package-update-recovery.js";
import type { UpdateRecoveryRecord } from "../../infra/update-run-recovery.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  gatewayServiceCommandUsesInterruptedPackageRoot,
  inspectUpdateCommandPackageGap,
} from "./update-command-package-replay.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import {
  discoverUpdateCommandRecovery,
  inspectUpdateCommandSealedReplay,
} from "./update-command-replay-inspection.js";
import { resolveUpdateCommandAdmissionEnv } from "./update-command-run.js";
import {
  resolveOwnedManagedUpdateEnv,
  resolveServiceRefreshEnv,
} from "./update-command-service-env.js";
import {
  GatewayServiceUpdateOwnershipError,
  isGatewayServiceManagementAllowedForUpdate,
} from "./update-command-service-plan.js";
import {
  isPendingStoppedServiceReplay,
  verifyStoppedServiceReplayPackage,
} from "./update-command-stopped-admission.js";

function matchesSource(record: UpdateRecoveryRecord, env: NodeJS.ProcessEnv) {
  return (
    record.source?.stateDir === resolveStateDir(env) &&
    record.source.configPath === resolveConfigPath(env) &&
    record.source.profile === (env.OPENCLAW_PROFILE?.trim() || null)
  );
}

/** Read-only admission from the explicitly selected profile. An unrelated
 * updater installation may resume its owned service, but a saved path alone
 * cannot redirect a fresh update or create a history row in another profile. */
export async function resolveUpdateCommandReplayAdmission(params: {
  opts: UpdateCommandOptions;
  root: string;
  invocationCwd?: string;
  timeoutMs?: number;
}) {
  let ordinaryEnv: NodeJS.ProcessEnv | undefined;
  let ownershipFailure: GatewayServiceUpdateOwnershipError | undefined;
  try {
    ordinaryEnv = await resolveUpdateCommandAdmissionEnv(params);
  } catch (error) {
    if (!(error instanceof GatewayServiceUpdateOwnershipError)) {
      throw error;
    }
    ownershipFailure = error;
  }
  const callerEnv = ordinaryEnv ?? resolveServiceRefreshEnv(process.env, params.invocationCwd);
  const pending = await discoverUpdateCommandRecovery(callerEnv);
  if (pending && (await inspectUpdateCommandPackageGap(pending))) {
    const refuse = () =>
      new UpdateCommandRecoveryPendingError(
        "Interrupted package restoration does not match the selected service and profile.",
      );
    if (
      !matchesSource(pending, callerEnv) ||
      !isGatewayServiceManagementAllowedForUpdate(callerEnv)
    ) {
      throw refuse();
    }
    const command = await resolveGatewayService().readCommand(callerEnv, {
      requireEffective: true,
      requireLoaded: true,
    });
    if (
      !command ||
      !(await gatewayServiceCommandUsesInterruptedPackageRoot({ record: pending, command }))
    ) {
      throw refuse();
    }
    const env = resolveOwnedManagedUpdateEnv({
      processEnv: callerEnv,
      serviceEnv: mergeGatewayServiceEnv(callerEnv, command),
      serviceDefinitionEnv: resolveManagedGatewayServiceCommand(command)?.environment,
      invocationCwd: params.invocationCwd,
    });
    if (!matchesSource(pending, env)) {
      throw refuse();
    }
    const descriptor = pending.package!.descriptor;
    const opened = await reopenPackageUpdateTransaction({
      descriptor,
      expectedLiveRoot: pending.from.root,
      expectedBinDir: descriptor.binDir,
      expectedTransactionId: pending.transactionId,
      pendingEffect: pending.effects.at(-1)!.package!.intent,
      hooks: {
        transactionId: pending.transactionId,
        beforeEffect: async () => {
          throw refuse();
        },
        persistDescriptor: async () => {
          throw refuse();
        },
      },
      timeoutMs: params.timeoutMs,
    });
    if (
      opened.status !== "ready" ||
      opened.observed.observation.previous !== "retained" ||
      opened.observed.observation.candidate !== "displaced" ||
      !(await inspectUpdateCommandPackageGap(pending))
    ) {
      throw refuse();
    }
    return {
      env,
      found: pending,
      root: pending.from.root,
      packageGap: true,
      stoppedService: false,
    };
  }
  if (ownershipFailure && pending && isPendingStoppedServiceReplay(pending, callerEnv)) {
    // This is a pending-only selection, never ordinary service admission. The
    // executor/source-owned native check must finish before reclaim or effects.
    if (pending.restore) {
      await inspectUpdateCommandSealedReplay(pending, callerEnv);
    }
    await verifyStoppedServiceReplayPackage(pending, params.timeoutMs);
    return {
      env: callerEnv,
      found: pending,
      root: pending.from.root,
      packageGap: false,
      stoppedService: true,
    };
  }
  if (ownershipFailure) {
    throw ownershipFailure;
  }
  return {
    env: callerEnv,
    found: pending,
    root: params.root,
    packageGap: false,
    stoppedService: false,
  };
}
