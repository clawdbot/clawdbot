import { getLoadedChannelPluginEntryById } from "../channels/plugins/registry-loaded.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";
import { collectChannelOperationFailures } from "./server-reload-utils.js";

export async function rollbackStoppedGatewayChannels(
  params: Pick<GatewayReloadHandlerParams, "startChannel" | "logChannels">,
  channels: Set<ChannelKind>,
  reason: string,
): Promise<string[]> {
  return await collectChannelOperationFailures({
    channels: [...channels],
    run: async (channel) => {
      params.logChannels.info(`restarting ${channel} channel after ${reason}`);
      // Registry selection and admission detachment belong to the channel manager.
      await params.startChannel(channel, undefined, { preserveManualStop: true });
      channels.delete(channel);
    },
    onFailure: (channel, err) => {
      params.logChannels.error(
        `failed to restart ${channel} channel after ${reason}: ${formatErrorMessage(err)}`,
      );
    },
  });
}

export async function restartGatewayChannels(options: {
  params: GatewayReloadHandlerParams;
  plan: GatewayReloadPlan;
  nextConfig: OpenClawConfig;
  channelsToRestart: Set<ChannelKind>;
  restartChannelAccounts: ReadonlyMap<ChannelKind, Set<string>>;
  activePluginChannelsAfterReload: ReadonlySet<ChannelKind> | null;
  channelsStoppedBeforePluginReload: Set<ChannelKind>;
  shouldSkipChannelRestart: boolean;
  skipChannelRestartLogMessage: string;
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
    shouldSkipChannelRestart,
    skipChannelRestartLogMessage,
    isLifecycleReloadAborted,
    getChannelAutostartSuppression,
    channelReloadTargets,
    logSuppressedChannelRestart,
    scheduleRecoveryRestart,
  } = options;
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
      const plugin = getLoadedChannelPluginEntryById(channel, params.getPluginRegistry())?.plugin;
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

  if (channelsToRestart.size === 0 && restartChannelAccounts.size === 0) {
    return;
  }
  if (shouldSkipChannelRestart) {
    params.logChannels.info(skipChannelRestartLogMessage);
    return;
  }
  const suppressed = Boolean(getChannelAutostartSuppression());
  const operation = suppressed ? "stop" : "restart";
  const phase = suppressed ? "suppressed hot reload" : "hot reload";
  const accountTargets = collectChannelAccountTargets();
  const accountFailures: string[] = [];
  for (const [channel, accountId] of accountTargets) {
    try {
      params.logChannels.info(
        suppressed
          ? `stopping ${channel} account ${accountId} before suppressed hot reload`
          : `restarting ${channel} account ${accountId}`,
      );
      await params.stopChannel(channel, accountId, { manual: false });
      if (!suppressed && !isLifecycleReloadAborted()) {
        await params.startChannel(channel, accountId, {
          preserveManualStop: true,
          skipUnavailableAccounts: true,
        });
      }
    } catch (err) {
      accountFailures.push(`${channel}[${accountId}]`);
      params.logChannels.error(
        `failed to ${operation} ${channel} account ${accountId} during ${phase}: ${formatErrorMessage(err)}`,
      );
    }
  }
  const channelFailures = await collectChannelOperationFailures({
    channels: channelsToRestart,
    run: async (channel) => {
      if (plan.reloadPlugins && activePluginChannelsAfterReload?.has(channel) === false) {
        return;
      }
      params.logChannels.info(
        suppressed
          ? `stopping ${channel} channel before suppressed hot reload`
          : `restarting ${channel} channel`,
      );
      if (!channelsStoppedBeforePluginReload.has(channel)) {
        await params.stopChannel(channel, undefined, { manual: false });
      }
      if (!suppressed && !isLifecycleReloadAborted()) {
        await params.startChannel(channel, undefined, {
          preserveManualStop: true,
          skipUnavailableAccounts: true,
        });
      }
    },
    onFailure: (channel, err) => {
      params.logChannels.error(
        `failed to ${operation} ${channel} channel during ${phase}: ${formatErrorMessage(err)}`,
      );
    },
  });
  const failures = [...accountFailures, ...channelFailures];
  if (failures.length > 0) {
    scheduleRecoveryRestart(`channel ${operation} (${failures.join(", ")})`);
  }
  if (suppressed) {
    logSuppressedChannelRestart(channelReloadTargets(), "channel restart during hot reload");
  }
}
