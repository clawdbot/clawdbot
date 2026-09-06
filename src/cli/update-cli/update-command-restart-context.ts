import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { resolveManagedGatewayServiceProcessEnv } from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { prepareRestartScript } from "./restart-helper.js";
import {
  resolveServiceRefreshEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  GatewayServiceUpdateOwnershipError,
  isGatewayServiceManagementAllowedForUpdate,
  resolveGatewayServiceManagementBlockMessageForUpdate,
} from "./update-command-service-plan.js";
import {
  revalidateManagedGatewayServiceAfterUpdate,
  resolvePostUpdateServiceStateReadEnv,
  resolveUpdatedGatewayRestartPort,
  shouldPrepareUpdatedInstallRestart,
  type PreManagedServiceStop,
} from "./update-command-service.js";

export type UpdateRestartParams = {
  result: UpdateRunResult;
  root: string;
  preManagedServiceStop?: PreManagedServiceStop;
  ownedManagedUpdateEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  shouldRestart: boolean;
  updateStepTimeoutMs: number;
};

export async function prepareUpdateRestart(
  params: UpdateRestartParams,
  restartConfigSnapshot: ConfigFileSnapshot,
) {
  let restartScriptPath: string | null = null;
  let refreshGatewayServiceEnv = false;
  let gatewayServiceEnv: NodeJS.ProcessEnv | undefined;
  let gatewayServiceInstallEnv: NodeJS.ProcessEnv | null | undefined;
  let serviceUpdateVerdict = params.preManagedServiceStop?.serviceUpdateVerdict;
  let skipLegacyServiceRestart = serviceUpdateVerdict?.kind === "absent";
  const serviceStateReadEnv = resolveServiceRefreshEnv(
    resolvePostUpdateServiceStateReadEnv({
      updateMode: params.result.mode,
      processEnv: process.env,
      preManagedServiceEnv: params.preManagedServiceStop?.serviceEnv,
    }),
    params.invocationCwd,
  );
  let serviceMutationAllowed =
    params.preManagedServiceStop?.serviceMutationAllowed !== false &&
    isGatewayServiceManagementAllowedForUpdate(process.env) &&
    isGatewayServiceManagementAllowedForUpdate(serviceStateReadEnv);
  let serviceMutationSkipMessage = !serviceMutationAllowed
    ? (params.preManagedServiceStop?.serviceMutationSkipMessage ??
      resolveGatewayServiceManagementBlockMessageForUpdate(process.env) ??
      resolveGatewayServiceManagementBlockMessageForUpdate(serviceStateReadEnv))
    : undefined;
  let gatewayPort = await resolveUpdatedGatewayRestartPort({
    config: restartConfigSnapshot.valid ? restartConfigSnapshot.config : undefined,
    processEnv: process.env,
    serviceEnv: params.ownedManagedUpdateEnv,
  });
  if (params.shouldRestart && serviceMutationAllowed && !skipLegacyServiceRestart) {
    try {
      const serviceState = await readGatewayServiceState(resolveGatewayService(), {
        env: serviceStateReadEnv,
        requireEffective: true,
        validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
        timeoutMs: params.updateStepTimeoutMs,
      });
      serviceUpdateVerdict = await revalidateManagedGatewayServiceAfterUpdate({
        state: serviceState,
        root: params.result.root ?? params.root,
        preManagedServiceStop: params.preManagedServiceStop,
        allowInstallRootChange: true,
      });
      gatewayServiceEnv = serviceState.env;
      skipLegacyServiceRestart =
        serviceUpdateVerdict.kind === "foreign" || serviceUpdateVerdict.kind === "absent";
      if (serviceUpdateVerdict.kind === "unavailable") {
        serviceMutationAllowed = false;
        serviceMutationSkipMessage = serviceUpdateVerdict.message;
      } else if (serviceUpdateVerdict.kind === "foreign") {
        serviceMutationAllowed = false;
        serviceMutationSkipMessage =
          "Gateway service management skipped: the service belongs to a different OpenClaw installation and was left untouched.";
      } else if (
        !skipLegacyServiceRestart &&
        shouldPrepareUpdatedInstallRestart({
          updateMode: params.result.mode,
          serviceInstalled: serviceState.installed,
          serviceLoaded: serviceState.loadState.status === "loaded",
          serviceStoppedForUpdate: params.preManagedServiceStop?.stopped,
          serviceMatchesUpdateRoot: serviceUpdateVerdict.kind === "owned",
          requiresInstallRootRefresh:
            serviceUpdateVerdict.kind === "owned" &&
            serviceUpdateVerdict.requiresInstallRootRefresh,
        })
      ) {
        gatewayServiceInstallEnv = resolveManagedGatewayServiceProcessEnv(
          serviceState.command,
          params.ownedManagedUpdateEnv ?? process.env,
        );
        if (gatewayServiceInstallEnv) {
          gatewayServiceInstallEnv = stripGatewayServiceMarkerEnv(gatewayServiceInstallEnv);
        }
        refreshGatewayServiceEnv =
          serviceUpdateVerdict.kind === "owned" && serviceUpdateVerdict.refreshDefinition;
        if (serviceUpdateVerdict.kind === "owned" && gatewayServiceInstallEnv === null) {
          refreshGatewayServiceEnv = false;
          serviceUpdateVerdict = { ...serviceUpdateVerdict, refreshDefinition: false };
        }
      }
      gatewayPort = await resolveUpdatedGatewayRestartPort({
        config: restartConfigSnapshot.valid ? restartConfigSnapshot.config : undefined,
        serviceEnv: gatewayServiceEnv,
        serviceCommand:
          serviceUpdateVerdict.kind === "unresolved" ||
          (serviceUpdateVerdict.kind === "owned" && !serviceUpdateVerdict.refreshDefinition)
            ? serviceState.command
            : undefined,
      });
      if (refreshGatewayServiceEnv) {
        restartScriptPath = await prepareRestartScript(
          serviceState.env,
          gatewayPort,
          serviceState.command?.programArguments,
        );
      }
    } catch (err) {
      if (params.preManagedServiceStop?.stopped) {
        const message =
          err instanceof GatewayServiceUpdateOwnershipError
            ? formatErrorMessage(err)
            : "Stopped gateway service could not be revalidated; inspect it before restarting manually.";
        throw new GatewayServiceUpdateOwnershipError(message, err);
      }
      serviceMutationAllowed = false;
      serviceMutationSkipMessage =
        "Code update completed; gateway service management skipped because its current ownership could not be inspected. " +
        "Run `openclaw gateway status --deep` before restarting it manually.";
    }
  }
  return {
    restartScriptPath,
    refreshGatewayServiceEnv,
    gatewayServiceEnv,
    gatewayServiceInstallEnv,
    serviceUpdateVerdict,
    skipLegacyServiceRestart,
    serviceStateReadEnv,
    serviceMutationAllowed,
    serviceMutationSkipMessage,
    gatewayPort,
  };
}
