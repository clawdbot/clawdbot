import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { DEFAULT_CHAT_CHANNEL } from "../channels/registry.js";
import { loadConfig } from "../config/config.js";
import { setVerbose } from "../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

type ChannelAuthOptions = {
  channel?: string;
  account?: string;
  verbose?: boolean;
};

const checkDisabledPlugin = (channelInput: string) => {
  try {
    const extPath = path.join(process.cwd(), "extensions", channelInput);
    if (fs.existsSync(extPath) && fs.statSync(extPath).isDirectory()) {
      return `Channel '${channelInput}' plugin found but likely disabled. Run 'clawdbot plugins enable ${channelInput}' to use it.`;
    }
  } catch {
    // ignore
  }
  return `Unsupported channel: ${channelInput}`;
};

export async function runChannelLogin(
  opts: ChannelAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const channelInput = opts.channel ?? DEFAULT_CHAT_CHANNEL;
  const channelId = normalizeChannelId(channelInput);
  if (!channelId) {
    throw new Error(checkDisabledPlugin(channelInput));
  }
  const plugin = getChannelPlugin(channelId);
  if (!plugin?.auth?.login) {
    throw new Error(`Channel ${channelId} does not support login`);
  }
  // Auth-only flow: do not mutate channel config here.
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const accountId = opts.account?.trim() || resolveChannelDefaultAccountId({ plugin, cfg });
  await plugin.auth.login({
    cfg,
    accountId,
    runtime,
    verbose: Boolean(opts.verbose),
    channelInput,
  });
}

export async function runChannelLogout(
  opts: ChannelAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const channelInput = opts.channel ?? DEFAULT_CHAT_CHANNEL;
  const channelId = normalizeChannelId(channelInput);
  if (!channelId) {
    throw new Error(checkDisabledPlugin(channelInput));
  }
  const plugin = getChannelPlugin(channelId);
  if (!plugin?.gateway?.logoutAccount) {
    throw new Error(`Channel ${channelId} does not support logout`);
  }
  // Auth-only flow: resolve account + clear session state only.
  const cfg = loadConfig();
  const accountId = opts.account?.trim() || resolveChannelDefaultAccountId({ plugin, cfg });
  const account = plugin.config.resolveAccount(cfg, accountId);
  await plugin.gateway.logoutAccount({
    cfg,
    accountId,
    account,
    runtime,
  });
}
