import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { commitConfigWithPendingPluginInstalls } from "../../cli/plugins-install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../cli/plugins-registry-refresh.js";
import { replaceConfigFile, type OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { channelLabel } from "./runtime-label.js";
import { type ChatChannel, requireValidConfigFileSnapshot, shouldUseWizard } from "./shared.js";

export type ChannelsRemoveOptions = {
  channel?: string;
  account?: string;
  delete?: boolean;
};

function listAccountIds(
  cfg: OpenClawConfig,
  channel: ChatChannel,
  plugin?: ChannelPlugin,
): string[] {
  plugin ??= getChannelPlugin(channel);
  if (!plugin) {
    return [];
  }
  return plugin.config.listAccountIds(cfg);
}

async function stopGatewayRuntimeBeforeRemove(params: {
  cfg: OpenClawConfig;
  channel: ChatChannel;
  accountId: string;
  plugin: ChannelPlugin;
  runtime: RuntimeEnv;
}) {
  if (!params.plugin.gateway?.startAccount && !params.plugin.gateway?.logoutAccount) {
    return;
  }
  try {
    await callGateway({
      config: params.cfg,
      method: "channels.stop",
      params: {
        channel: params.channel,
        accountId: params.accountId,
      },
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      deviceIdentity: null,
    });
  } catch (error) {
    params.runtime.log(
      `Could not stop running ${channelLabel(params.channel)} account "${params.accountId}" before removing it: ${formatErrorMessage(error)}`,
    );
  }
}

export async function channelsRemoveCommand(
  opts: ChannelsRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const baseHash = configSnapshot.hash;
  let cfg = (configSnapshot.sourceConfig ?? configSnapshot.config) as OpenClawConfig;

  const useWizard = shouldUseWizard(params);
  const prompter = useWizard ? createClackPrompter() : null;
  const rawChannel = normalizeOptionalString(opts.channel) ?? "";
  let lookupChannel = rawChannel;
  let channel: ChatChannel | null = normalizeChannelId(rawChannel);
  let accountId = normalizeAccountId(opts.account);
  const deleteConfig = Boolean(opts.delete);

  if (useWizard && prompter) {
    await prompter.intro("Remove channel account");
    const readOnlyPlugins = listReadOnlyChannelPluginsForConfig(cfg, {
      includeSetupFallbackPlugins: true,
    });
    const selectedChannel = await prompter.select({
      message: "Channel",
      options: readOnlyPlugins.map((plugin) => ({
        value: plugin.id,
        label: plugin.meta.label,
      })),
    });
    channel = selectedChannel;
    lookupChannel = selectedChannel;

    accountId = await (async () => {
      const readOnlyPlugin = readOnlyPlugins.find((plugin) => plugin.id === selectedChannel);
      const ids = listAccountIds(cfg, selectedChannel, readOnlyPlugin);
      const choice = await prompter.select({
        message: "Account",
        options: ids.map((id) => ({
          value: id,
          label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
        })),
        initialValue: ids[0] ?? DEFAULT_ACCOUNT_ID,
      });
      return normalizeAccountId(choice);
    })();

    const wantsDisable = await prompter.confirm({
      message: `Disable ${channelLabel(selectedChannel)} account "${accountId}"? (keeps config)`,
      initialValue: true,
    });
    if (!wantsDisable) {
      await prompter.outro("Cancelled.");
      return;
    }
  } else {
    if (!rawChannel) {
      runtime.error("Channel is required. Use --channel <name>.");
      runtime.exit(1);
      return;
    }
    if (!deleteConfig) {
      const confirm = createClackPrompter();
      const channelPromptLabel = channel ? channelLabel(channel) : rawChannel;
      const ok = await confirm.confirm({
        message: `Disable ${channelPromptLabel} account "${accountId}"? (keeps config)`,
        initialValue: true,
      });
      if (!ok) {
        return;
      }
    }
  }

  const shouldResolveInstallablePlugin = Boolean(lookupChannel || channel);
  const resolvedPluginState = shouldResolveInstallablePlugin
    ? await (async () => {
        const { resolveInstallableChannelPlugin } =
          await import("../channel-setup/channel-plugin-resolution.js");
        return await resolveInstallableChannelPlugin({
          cfg,
          runtime,
          rawChannel: lookupChannel,
          allowInstall: false,
        });
      })()
    : null;
  if (resolvedPluginState?.configChanged) {
    cfg = resolvedPluginState.cfg;
  }
  const resolvedChannel = resolvedPluginState?.channelId ?? channel;
  if (!resolvedChannel) {
    runtime.error(`Unknown channel: ${rawChannel}`);
    runtime.exit(1);
    return;
  }
  channel = resolvedChannel;
  const plugin = resolvedPluginState?.plugin ?? getChannelPlugin(resolvedChannel);
  if (!plugin) {
    if (resolvedPluginState?.catalogEntry) {
      runtime.error(
        `Channel plugin "${resolvedPluginState.catalogEntry.id}" is not installed. Run "openclaw channels add --channel ${resolvedPluginState.catalogEntry.id}" first.`,
      );
      runtime.exit(1);
      return;
    }
    runtime.error(`Unknown channel: ${resolvedChannel}`);
    runtime.exit(1);
    return;
  }
  const resolvedChannelId: ChatChannel = resolvedChannel;
  const resolvedAccountId =
    normalizeAccountId(accountId) ?? resolveChannelDefaultAccountId({ plugin, cfg });
  const accountKey = resolvedAccountId || DEFAULT_ACCOUNT_ID;

  await stopGatewayRuntimeBeforeRemove({
    cfg,
    channel: resolvedChannelId,
    accountId: accountKey,
    plugin,
    runtime,
  });

  let next = { ...cfg };
  const prevCfg = cfg;
  if (deleteConfig) {
    if (!plugin.config.deleteAccount) {
      runtime.error(`Channel ${channel} does not support delete.`);
      runtime.exit(1);
      return;
    }
    next = plugin.config.deleteAccount({
      cfg: next,
      accountId: resolvedAccountId,
    });
    await plugin.lifecycle?.onAccountRemoved?.({
      prevCfg,
      accountId: resolvedAccountId,
      runtime,
    });
  } else {
    if (!plugin.config.setAccountEnabled) {
      runtime.error(`Channel ${channel} does not support disable.`);
      runtime.exit(1);
      return;
    }
    next = plugin.config.setAccountEnabled({
      cfg: next,
      accountId: resolvedAccountId,
      enabled: false,
    });
    await plugin.lifecycle?.onAccountConfigChanged?.({
      prevCfg,
      nextCfg: next,
      accountId: resolvedAccountId,
      runtime,
    });
  }

  const shouldMovePluginInstalls = Boolean(
    next.plugins?.installs && Object.keys(next.plugins.installs).length > 0,
  );
  if (shouldMovePluginInstalls) {
    const committed = await commitConfigWithPendingPluginInstalls({
      nextConfig: next,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    next = committed.config;
    await refreshPluginRegistryAfterConfigMutation({
      config: next,
      reason: "source-changed",
      installRecords: committed.installRecords,
      logger: { warn: (message) => runtime.log(message) },
    });
  } else {
    await replaceConfigFile({
      nextConfig: next,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    if (resolvedPluginState?.pluginInstalled) {
      await refreshPluginRegistryAfterConfigMutation({
        config: next,
        reason: "source-changed",
        logger: { warn: (message) => runtime.log(message) },
      });
    }
  }
  if (useWizard && prompter) {
    await prompter.outro(
      deleteConfig
        ? `Deleted ${channelLabel(resolvedChannelId)} account "${accountKey}".`
        : `Disabled ${channelLabel(resolvedChannelId)} account "${accountKey}".`,
    );
  } else {
    runtime.log(
      deleteConfig
        ? `Deleted ${channelLabel(resolvedChannelId)} account "${accountKey}".`
        : `Disabled ${channelLabel(resolvedChannelId)} account "${accountKey}".`,
    );
  }
}
