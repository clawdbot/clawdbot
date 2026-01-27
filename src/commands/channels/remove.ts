import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { type MoltbotConfig, writeConfigFile } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { type ChatChannel, channelLabel, requireValidConfig, shouldUseWizard } from "./shared.js";

export type ChannelsRemoveOptions = {
  channel?: string;
  account?: string;
  delete?: boolean;
};

function listAccountIds(cfg: MoltbotConfig, channel: ChatChannel): string[] {
  const plugin = getChannelPlugin(channel);
  if (!plugin) return [];
  return plugin.config.listAccountIds(cfg);
}

export async function channelsRemoveCommand(
  opts: ChannelsRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const useWizard = shouldUseWizard(params);
  const prompter = useWizard ? createClackPrompter() : null;
  let channel: ChatChannel | null = normalizeChannelId(opts.channel);
  let accountId = normalizeAccountId(opts.account);
  const deleteConfig = Boolean(opts.delete);

  if (useWizard && prompter) {
    await prompter.intro("Remove channel account");
    const selectedChannel = (await prompter.select({
      message: "Channel",
      options: listChannelPlugins().map((plugin) => ({
        value: plugin.id,
        label: plugin.meta.label,
      })),
    })) as ChatChannel;
    channel = selectedChannel;

    accountId = await (async () => {
      const ids = listAccountIds(cfg, selectedChannel);
      const choice = (await prompter.select({
        message: "Account",
        options: ids.map((id) => ({
          value: id,
          label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
        })),
        initialValue: ids[0] ?? DEFAULT_ACCOUNT_ID,
      })) as string;
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
    if (!channel) {
      runtime.error("Channel is required. Use --channel <name>.");
      runtime.exit(1);
      return;
    }
    if (!deleteConfig) {
      const confirm = createClackPrompter();
      const ok = await confirm.confirm({
        message: `Disable ${channelLabel(channel)} account "${accountId}"? (keeps config)`,
        initialValue: true,
      });
      if (!ok) {
        return;
      }
    }
  }

  const plugin = getChannelPlugin(channel);
  if (!plugin) {
    runtime.error(`Unknown channel: ${channel}`);
    runtime.exit(1);
    return;
  }

  const resolvedAccountId =
    normalizeAccountId(accountId) ?? resolveChannelDefaultAccountId({ plugin, cfg });
  const accountKey = resolvedAccountId || DEFAULT_ACCOUNT_ID;

  let next = { ...cfg };
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
  }

  await writeConfigFile(next);
  if (useWizard && prompter) {
    await prompter.outro(
      deleteConfig
        ? `Deleted ${channelLabel(channel)} account "${accountKey}".`
        : `Disabled ${channelLabel(channel)} account "${accountKey}".`,
    );
  } else {
    runtime.log(
      deleteConfig
        ? `Deleted ${channelLabel(channel)} account "${accountKey}".`
        : `Disabled ${channelLabel(channel)} account "${accountKey}".`,
    );
  }
}
