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

function getChannelAccountIndexReloadPaths(channel: ChannelKind): ReadonlySet<string> {
  const paths = getChannelPlugin(channel)?.reload?.accountIndexReloadPaths ?? [];
  return new Set(paths);
}

function isChannelAccountIndexReloadPath(path: string, channel: ChannelKind): boolean {
  return getChannelAccountIndexReloadPaths(channel).has(path);
}

function isChannelPath(path: string, channel: ChannelKind): boolean {
  const channelPrefix = `channels.${channel}`;
  return path === channelPrefix || path.startsWith(`${channelPrefix}.`);
}

function hasCompetingChannelConfigChange(
  changedPaths: readonly string[],
  channel: ChannelKind,
): boolean {
  return changedPaths.some(
    (path) => isChannelPath(path, channel) && !isChannelAccountIndexReloadPath(path, channel),
  );
}

export function shouldIncludeKnownAccountsForPluginReload(
  changedPaths: readonly string[],
  channel: ChannelKind,
): boolean {
  return !hasCompetingChannelConfigChange(changedPaths, channel);
}

function shouldIncludeKnownAccountsForAccountIndexReload(
  changedPaths: readonly string[],
  channel: ChannelKind,
): boolean {
  return (
    changedPaths.some((path) => isChannelAccountIndexReloadPath(path, channel)) &&
    !hasCompetingChannelConfigChange(changedPaths, channel)
  );
}

function startGatewayChannelFromActiveRegistry(
  params: Pick<GatewayReloadHandlerParams, "startChannel">,
  channel: ChannelKind,
  accountId?: string,
  options?: Parameters<GatewayReloadHandlerParams["startChannel"]>[2],
): Promise<void> {
  return withPluginRuntimeRegistryScope(requireActivePluginChannelRegistry(), () =>
    runOutsideGatewayRootWorkAdmission(() =>
      accountId === undefined
        ? params.startChannel(channel, undefined, options)
        : params.startChannel(channel, accountId, options),
    ),
  );
}

export async function restartStoppedPluginAccounts(options: {
  params: GatewayReloadHandlerParams;
  reason: string;
  accountsStoppedBeforePluginReload: Map<ChannelKind, Set<string>>;
  channelsStoppedBeforePluginReload: ReadonlySet<ChannelKind>;
}): Promise<string[]> {
  const failures: string[] = [];
  for (const [channel, accountIds] of options.accountsStoppedBeforePluginReload) {
    if (options.channelsStoppedBeforePluginReload.has(channel)) {
      options.accountsStoppedBeforePluginReload.delete(channel);
      continue;
    }
    for (const accountId of accountIds) {
      try {
        options.params.logChannels.info(
          `restarting ${channel} account ${accountId} after ${options.reason}`,
        );
        await startGatewayChannelFromActiveRegistry(options.params, channel, accountId, {
          preserveManualStop: true,
        });
        accountIds.delete(accountId);
      } catch (err) {
        failures.push(`${channel}[${accountId}]`);
        options.params.logChannels.error(
          `failed to restart ${channel} account ${accountId} after ${options.reason}: ${formatErrorMessage(err)}`,
        );
      }
    }
    if (accountIds.size === 0) {
      options.accountsStoppedBeforePluginReload.delete(channel);
    }
  }
  return failures;
}

export async function restartGatewayChannels(options: {
  params: GatewayReloadHandlerParams;
  plan: GatewayReloadPlan;
  nextConfig: OpenClawConfig;
  channelsToRestart: Set<ChannelKind>;
  restartChannelAccounts: ReadonlyMap<ChannelKind, Set<string>>;
  activePluginChannelsAfterReload: ReadonlySet<ChannelKind> | null;
  channelsStoppedBeforePluginReload: Set<ChannelKind>;
  accountsStoppedBeforePluginReload: Map<ChannelKind, Set<string>>;
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
            if (accountsStoppedBeforePluginReload.get(channel)?.has(accountId)) {
              continue;
            }
            params.logChannels.info(
              `stopping ${channel} account ${accountId} before suppressed hot reload`,
            );
            await params.stopChannel(channel, accountId, {
              manual: false,
              restartPending: false,
            });
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
            await params.stopChannel(channel, undefined, {
              manual: false,
              restartPending: false,
            });
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
            const stoppedBeforePluginReload = accountsStoppedBeforePluginReload
              .get(channel)
              ?.has(accountId);
            if (!stoppedBeforePluginReload) {
              await params.stopChannel(channel, accountId, {
                manual: false,
                restartPending: false,
              });
            }
            if (isLifecycleReloadAborted()) {
              continue;
            }
            await startGatewayChannelFromActiveRegistry(params, channel, accountId, {
              preserveManualStop: true,
            });
            if (stoppedBeforePluginReload) {
              const stoppedAccountIds = accountsStoppedBeforePluginReload.get(channel);
              stoppedAccountIds?.delete(accountId);
              if (stoppedAccountIds?.size === 0) {
                accountsStoppedBeforePluginReload.delete(channel);
              }
            }
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
          const includeKnownAccounts =
            (plan.reloadPlugins &&
              channelsStoppedBeforePluginReload.has(name) &&
              shouldIncludeKnownAccountsForPluginReload(plan.changedPaths, name)) ||
            (!plan.reloadPlugins &&
              shouldIncludeKnownAccountsForAccountIndexReload(plan.changedPaths, name));
          params.logChannels.info(`restarting ${name} channel`);
          if (!channelsStoppedBeforePluginReload.has(name)) {
            await params.stopChannel(
              name,
              undefined,
              includeKnownAccounts
                ? {
                    manual: false,
                    restartPending: false,
                    preserveKnownAccount: true,
                  }
                : { manual: false, restartPending: false },
            );
          }
          if (isLifecycleReloadAborted()) {
            return;
          }
          if (includeKnownAccounts) {
            await startGatewayChannelFromActiveRegistry(params, name, undefined, {
              includeKnownAccounts: true,
              preserveManualStop: true,
            });
          } else {
            await startGatewayChannelFromActiveRegistry(params, name, undefined, {
              preserveManualStop: true,
            });
          }
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
