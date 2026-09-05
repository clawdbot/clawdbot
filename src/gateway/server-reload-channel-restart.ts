import { getLoadedChannelPluginEntryById } from "../channels/plugins/registry-loaded.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ChannelKind } from "./config-reload-plan.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";

export async function restartGatewayChannels(options: {
  params: Pick<
    GatewayReloadHandlerParams,
    | "startChannel"
    | "stopChannel"
    | "logChannels"
    | "getPluginRegistry"
    | "releaseChannelRouteHandoffs"
  >;
  nextConfig: OpenClawConfig;
  channelsToRestart: Set<ChannelKind>;
  restartChannelAccounts: ReadonlyMap<ChannelKind, Set<string>>;
  activePluginChannelsAfterReload: ReadonlySet<ChannelKind> | null;
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
    nextConfig,
    channelsToRestart,
    restartChannelAccounts,
    activePluginChannelsAfterReload,
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
        activePluginChannelsAfterReload?.has(channel) === false
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
  const targets: Array<[ChannelKind, string?]> = [
    ...collectChannelAccountTargets(),
    ...[...channelsToRestart].map((channel): [ChannelKind] => [channel]),
  ];
  const failures: string[] = [];
  for (const [channel, accountId] of targets) {
    if (activePluginChannelsAfterReload?.has(channel) === false) {
      continue;
    }
    const target =
      accountId === undefined ? `${channel} channel` : `${channel} account ${accountId}`;
    try {
      params.logChannels.info(
        suppressed ? `stopping ${target} before suppressed hot reload` : `restarting ${target}`,
      );
      const canRestart = () => !suppressed && !isLifecycleReloadAborted();
      await params.stopChannel(channel, accountId, {
        manual: false,
        ...(canRestart() ? { routeHandoff: true } : {}),
      });
      if (canRestart()) {
        const outcomes = await params.startChannel(channel, accountId, {
          preserveManualStop: true,
          skipUnavailableAccounts: true,
        });
        for (const [id, outcome] of outcomes) {
          if (outcome.status === "retry") {
            throw new Error(`${channel}[${id}] replacement not admitted: ${outcome.reason}`);
          }
        }
      } else {
        params.releaseChannelRouteHandoffs(channel, accountId);
      }
    } catch (err) {
      failures.push(accountId === undefined ? channel : `${channel}[${accountId}]`);
      params.logChannels.error(
        `failed to ${operation} ${target} during ${phase}: ${formatErrorMessage(err)}`,
      );
    }
  }
  if (failures.length > 0) {
    scheduleRecoveryRestart(`channel ${operation} (${failures.join(", ")})`);
  }
  if (suppressed) {
    logSuppressedChannelRestart(channelReloadTargets(), "channel restart during hot reload");
  }
}
