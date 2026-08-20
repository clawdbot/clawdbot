import { getChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { requireActivePluginChannelRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { runOutsideGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import type { ChannelKind } from "./config-reload-plan.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";
import { collectChannelOperationFailures } from "./server-reload-utils.js";

export function startGatewayChannelFromActiveRegistry(
  params: Pick<GatewayReloadHandlerParams, "startChannel">,
  channel: ChannelKind,
  accountId?: string,
): Promise<void> {
  return withPluginRuntimeRegistryScope(requireActivePluginChannelRegistry(), () =>
    runOutsideGatewayRootWorkAdmission(() =>
      accountId === undefined
        ? params.startChannel(channel)
        : params.startChannel(channel, accountId),
    ),
  );
}

export async function restartGatewayChannels(options: {
  params: GatewayReloadHandlerParams;
  plan: GatewayReloadPlan;
  nextConfig: OpenClawConfig;
  channelsToRestart: Set<ChannelKind>;
  restartChannelAccounts: ReadonlyMap<ChannelKind, Set<string>>;
  activePluginChannelsAfterReload: ReadonlySet<ChannelKind> | null;
  channelsStoppedBeforePluginReload: Set<ChannelKind>;
  accountsStoppedBeforePluginReload: ReadonlyMap<ChannelKind, ReadonlySet<string>>;
  shouldSkipChannelRestart: boolean;
  skipChannelRestartLogMessage: string;
  pluginReloadAborted: boolean;
  isLifecycleReloadAborted: () => boolean;
  getChannelAutostartSuppression: () => unknown;
  channelReloadTargets: () => Set<ChannelKind>;
  logSuppressedChannelRestart: (channels: ReadonlySet<ChannelKind>, action: string) => void;
  scheduleRecoveryRestart: (surface: string, err?: unknown) => void;
}): Promise<void> {
  const {
    params,
    plan,
    nextConfig,
    channelsToRestart,
    restartChannelAccounts,
    activePluginChannelsAfterReload,
    channelsStoppedBeforePluginReload,
    accountsStoppedBeforePluginReload,
    shouldSkipChannelRestart,
    skipChannelRestartLogMessage,
    pluginReloadAborted,
    isLifecycleReloadAborted,
    getChannelAutostartSuppression,
    channelReloadTargets,
    logSuppressedChannelRestart,
    scheduleRecoveryRestart,
  } = options;
  const wasStoppedBeforePluginReload = (channel: ChannelKind, accountId: string) =>
    accountsStoppedBeforePluginReload.get(channel)?.has(accountId) === true;
  // Suppressed and normal reloads share fallback selection so stale account
  // ids always reach the wholesale path that evicts their old runtime.
  const collectChannelAccountTargets = (): Array<[ChannelKind, string]> => {
    const targets: Array<[ChannelKind, string]> = [];
    for (const [channel, accountIds] of restartChannelAccounts) {
      if (
        channelsToRestart.has(channel) ||
        (plan.reloadPlugins && activePluginChannelsAfterReload?.has(channel) === false)
      ) {
        continue;
      }
      const plugin = getChannelPlugin(channel);
      let listedAccountIds: Set<string>;
      try {
        listedAccountIds = new Set(plugin?.config.listAccountIds(nextConfig) ?? []);
      } catch (err) {
        scheduleRecoveryRestart(`channel account enumeration (${channel})`, err);
        continue;
      }
      if ([...accountIds].some((accountId) => !listedAccountIds.has(accountId))) {
        channelsToRestart.add(channel);
        continue;
      }
      try {
        for (const accountId of accountIds) {
          plugin?.config.resolveAccount(nextConfig, accountId);
        }
      } catch (err) {
        params.logChannels.info(
          `promoting ${channel} account reload to whole-channel restart after account resolution failed: ${formatErrorMessage(err)}`,
        );
        channelsToRestart.add(channel);
        continue;
      }
      for (const accountId of accountIds) {
        targets.push([channel, accountId]);
      }
    }
    return targets;
  };

  if (channelsToRestart.size > 0 || restartChannelAccounts.size > 0) {
    if (shouldSkipChannelRestart) {
      params.logChannels.info(skipChannelRestartLogMessage);
    } else if (getChannelAutostartSuppression()) {
      const cancelledByRestart = pluginReloadAborted;
      if (cancelledByRestart) {
        params.logChannels.info("channel restart cancelled by in-process restart");
      } else {
        const accountStops = collectChannelAccountTargets();
        const accountStopFailures: string[] = [];
        for (const [channel, accountId] of accountStops) {
          try {
            params.logChannels.info(
              `stopping ${channel} account ${accountId} before suppressed hot reload`,
            );
            if (!wasStoppedBeforePluginReload(channel, accountId)) {
              await params.stopChannel(channel, accountId, { manual: false });
            }
          } catch (err) {
            accountStopFailures.push(`${channel}[${accountId}]`);
            params.logChannels.error(
              `failed to stop ${channel} account ${accountId} during suppressed hot reload: ${formatErrorMessage(err)}`,
            );
          }
        }
        const stopFailures = await collectChannelOperationFailures({
          channels: channelsToRestart,
          run: async (channel) => {
            if (plan.reloadPlugins && activePluginChannelsAfterReload?.has(channel) === false) {
              return;
            }
            if (channelsStoppedBeforePluginReload.has(channel)) {
              return;
            }
            params.logChannels.info(`stopping ${channel} channel before suppressed hot reload`);
            await params.stopChannel(channel, undefined, { manual: false });
          },
          onFailure: (channel, err) => {
            params.logChannels.error(
              `failed to stop ${channel} channel during suppressed hot reload: ${formatErrorMessage(
                err,
              )}`,
            );
          },
        });
        const allStopFailures = [...accountStopFailures, ...stopFailures];
        if (allStopFailures.length > 0) {
          scheduleRecoveryRestart(`channel stop (${allStopFailures.join(", ")})`);
        }
        logSuppressedChannelRestart(channelReloadTargets(), "channel restart during hot reload");
      }
    } else {
      const cancelledByRestart = pluginReloadAborted;
      if (cancelledByRestart) {
        params.logChannels.info("channel restart cancelled by in-process restart");
      } else {
        const accountRestarts = collectChannelAccountTargets();
        const accountRestartFailures: string[] = [];
        for (const [channel, accountId] of accountRestarts) {
          try {
            params.logChannels.info(`restarting ${channel} account ${accountId}`);
            if (!wasStoppedBeforePluginReload(channel, accountId)) {
              await params.stopChannel(channel, accountId, { manual: false });
            }
            if (isLifecycleReloadAborted()) {
              continue;
            }
            await startGatewayChannelFromActiveRegistry(params, channel, accountId);
          } catch (err) {
            accountRestartFailures.push(`${channel}[${accountId}]`);
            params.logChannels.error(
              `failed to restart ${channel} account ${accountId} during hot reload: ${formatErrorMessage(err)}`,
            );
          }
        }
        const restartChannel = async (name: ChannelKind) => {
          if (plan.reloadPlugins && activePluginChannelsAfterReload?.has(name) === false) {
            return;
          }
          params.logChannels.info(`restarting ${name} channel`);
          if (!channelsStoppedBeforePluginReload.has(name)) {
            await params.stopChannel(name, undefined, { manual: false });
          }
          if (isLifecycleReloadAborted()) {
            return;
          }
          await startGatewayChannelFromActiveRegistry(params, name);
        };
        const restartFailures = await collectChannelOperationFailures({
          channels: channelsToRestart,
          run: restartChannel,
          onFailure: (channel, err) => {
            params.logChannels.error(
              `failed to restart ${channel} channel during hot reload: ${formatErrorMessage(err)}`,
            );
          },
        });
        const allRestartFailures = [...accountRestartFailures, ...restartFailures];
        if (allRestartFailures.length > 0) {
          scheduleRecoveryRestart(`channel restart (${allRestartFailures.join(", ")})`);
        }
      }
    }
  }
}
