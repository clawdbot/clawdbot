// Implements guided and non-interactive disable/delete for channel accounts.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type ChannelIngressQueueAccountPurge,
  purgeChannelIngressQueueAccount,
} from "../../channels/message/ingress-queue.js";
import {
  applyPreparedChannelAccountRemoval,
  type ChannelAccountMutationPlugin,
  prepareChannelAccountRemoval,
} from "../../channels/plugins/account-config-mutation.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  formatUnknownChannelMessage,
  formatUnsupportedChannelActionMessage,
} from "../../cli/error-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { resolveChannelIngressQueueOwnerId } from "./ingress-queue-owner.js";
import { persistChannelPluginConfig } from "./plugin-config-persistence.js";
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
  pluginInput?: ChannelAccountMutationPlugin,
): string[] {
  let plugin = pluginInput;
  plugin ??= getChannelPlugin(channel);
  if (!plugin) {
    return [];
  }
  return plugin.config.listAccountIds(cfg);
}

type IngressDiscardOutcome =
  | { ok: true; purge: ChannelIngressQueueAccountPurge }
  | { ok: false; message: string };

/**
 * Discards a removed account's ingress rows without letting that failure rewrite the
 * outcome of the removal.
 *
 * The config write has already landed by the time this runs, so the account is gone
 * whatever happens here. Letting the purge throw would surface a completed deletion as
 * a failed command - the state store can refuse a write for reasons that have nothing
 * to do with this account, such as another process owning it. Report the shortfall in
 * the same line that reports the deletion instead, the way the pre-removal runtime stop
 * already does.
 */
function discardRemovedAccountIngressRows(params: {
  channelId: string;
  accountId: string;
}): IngressDiscardOutcome {
  try {
    return {
      ok: true,
      purge: purgeChannelIngressQueueAccount({
        channelId: params.channelId,
        accountId: params.accountId,
      }),
    };
  } catch (error) {
    return { ok: false, message: formatErrorMessage(error) };
  }
}

async function stopGatewayRuntimeBeforeRemove(params: {
  cfg: OpenClawConfig;
  channel: ChatChannel;
  accountId: string;
  shouldStopRuntime: boolean;
  runtime: RuntimeEnv;
}) {
  if (!params.shouldStopRuntime) {
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

function formatDiscardedIngressEvents(purge: ChannelIngressQueueAccountPurge): string {
  const events = `${purge.discarded} stored ingress event${purge.discarded === 1 ? "" : "s"}`;
  return purge.undelivered > 0
    ? `Discarded ${events}, ${purge.undelivered} of which had not been answered yet.`
    : `Discarded ${events}.`;
}

/** Disable or delete a channel account, stopping gateway runtime state before mutation. */
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
  const cfg: OpenClawConfig = configSnapshot.sourceConfig;

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
      runtime.error(
        `Missing channel. Use ${formatCliCommand("openclaw channels remove --channel <name>")} or run ${formatCliCommand("openclaw channels status")} to inspect configured channels.`,
      );
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
  const resolvedChannel = resolvedPluginState?.channelId ?? channel;
  if (!resolvedChannel) {
    runtime.error(formatUnknownChannelMessage({ channel: rawChannel }));
    runtime.exit(1);
    return;
  }
  channel = resolvedChannel;
  const plugin = resolvedPluginState?.plugin ?? getChannelPlugin(resolvedChannel);
  if (!plugin) {
    if (resolvedPluginState?.catalogEntry) {
      runtime.error(
        `Channel plugin "${resolvedPluginState.catalogEntry.id}" is not installed. Run ${formatCliCommand(`openclaw channels add --channel ${resolvedPluginState.catalogEntry.id}`)} first.`,
      );
      runtime.exit(1);
      return;
    }
    runtime.error(formatUnknownChannelMessage({ channel: resolvedChannel }));
    runtime.exit(1);
    return;
  }
  const resolvedChannelId: ChatChannel = resolvedChannel;
  const preparedRemoval = prepareChannelAccountRemoval({
    plugin,
    accountId,
    action: deleteConfig ? "delete" : "disable",
  });

  await stopGatewayRuntimeBeforeRemove({
    cfg,
    channel: resolvedChannelId,
    accountId: preparedRemoval.accountKey,
    shouldStopRuntime: preparedRemoval.shouldStopRuntime,
    runtime,
  });

  const removal = await applyPreparedChannelAccountRemoval({
    cfg,
    prepared: preparedRemoval,
    runtime,
  });
  if (!removal.ok) {
    runtime.error(
      removal.error.action === "delete"
        ? `${formatUnsupportedChannelActionMessage({ channel, action: "delete" })} Use ${formatCliCommand("openclaw channels remove --channel " + channel)} to disable it without deleting config.`
        : `${formatUnsupportedChannelActionMessage({ channel, action: "disable" })} Use ${formatCliCommand("openclaw channels remove --channel " + channel + " --delete")} only if you want to remove config.`,
    );
    runtime.exit(1);
    return;
  }
  await persistChannelPluginConfig({
    cfg: removal.value.nextConfig,
    pluginInstalled: false,
    ...(baseHash !== undefined ? { baseHash } : {}),
    runtime,
  });
  // Ingress retention prunes on admission, so a deleted account - which never admits
  // again - would own its rows forever. Discard them once the removal is durable:
  // running before the config write would drop inbound work for an account that is
  // still configured if that write fails. A disabled account keeps its rows because
  // re-enabling it drains them.
  const discard = deleteConfig
    ? discardRemovedAccountIngressRows({
        channelId: resolveChannelIngressQueueOwnerId({
          channelId: plugin.id,
          catalogPluginId: resolvedPluginState?.catalogEntry?.pluginId,
        }),
        accountId: preparedRemoval.accountKey,
      })
    : undefined;
  const summary = [
    deleteConfig
      ? `Deleted ${channelLabel(resolvedChannelId)} account "${preparedRemoval.accountKey}".`
      : `Disabled ${channelLabel(resolvedChannelId)} account "${preparedRemoval.accountKey}".`,
    ...(discard?.ok && discard.purge.discarded > 0
      ? [formatDiscardedIngressEvents(discard.purge)]
      : []),
    ...(discard?.ok === false
      ? [`Its stored ingress events could not be discarded: ${discard.message}`]
      : []),
  ].join(" ");
  if (useWizard && prompter) {
    await prompter.outro(summary);
  } else {
    runtime.log(summary);
  }
}
