import { getChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { requireActivePluginChannelRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { runOutsideGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";
import { collectChannelOperationFailures } from "./server-reload-utils.js";

function startGatewayChannelFromActiveRegistry(
  params: Pick<GatewayReloadHandlerParams, "startChannel">,
  channel: ChannelKind,
  accountId?: string,
): Promise<void> {
  return withPluginRuntimeRegistryScope(requireActivePluginChannelRegistry(), () =>
    // Reload and rollback replace snapshots, not the operator's stopped intent.
    runOutsideGatewayRootWorkAdmission(() =>
      params.startChannel(channel, accountId, { preserveManualStop: true }),
    ),
  );
}

export async function rollbackStoppedGatewayChannels(
  params: Pick<GatewayReloadHandlerParams, "startChannel" | "logChannels">,
  channels: Set<ChannelKind>,
  accounts: Map<ChannelKind, Set<string>>,
  reason: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const [channel, accountIds] of accounts) {
    for (const accountId of accountIds) {
      try {
        params.logChannels.info(`restarting ${channel} account ${accountId} after ${reason}`);
        await startGatewayChannelFromActiveRegistry(params, channel, accountId);
        accountIds.delete(accountId);
      } catch (err) {
        failures.push(`${channel}[${accountId}]`);
        params.logChannels.error(
          `failed to restart ${channel} account ${accountId} after ${reason}: ${formatErrorMessage(err)}`,
        );
      }
    }
    if (accountIds.size === 0) {
      accounts.delete(channel);
    }
  }
  return failures.concat(
    await collectChannelOperationFailures({
      channels: [...channels],
      run: async (channel) => {
        params.logChannels.info(`restarting ${channel} channel after ${reason}`);
        await startGatewayChannelFromActiveRegistry(params, channel);
        channels.delete(channel);
      },
      onFailure: (channel, err) => {
        params.logChannels.error(
          `failed to restart ${channel} channel after ${reason}: ${formatErrorMessage(err)}`,
        );
      },
    }),
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
      if (!wasStoppedBeforePluginReload(channel, accountId)) {
        await params.stopChannel(channel, accountId, { manual: false });
      }
      if (!suppressed && !isLifecycleReloadAborted()) {
        await startGatewayChannelFromActiveRegistry(params, channel, accountId);
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
        await startGatewayChannelFromActiveRegistry(params, channel);
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
