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
  json?: boolean;
  timeoutMs?: number;
};

export async function runChannelLogin(
  opts: ChannelAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const channelInput = opts.channel ?? DEFAULT_CHAT_CHANNEL;
  const channelId = normalizeChannelId(channelInput);
  if (!channelId) {
    throw new Error(`Unsupported channel: ${channelInput}`);
  }
  const plugin = getChannelPlugin(channelId);

  // JSON mode: use gateway QR login methods for programmatic access
  if (opts.json) {
    if (!plugin?.gateway?.loginWithQrStart || !plugin?.gateway?.loginWithQrWait) {
      throw new Error(`Channel ${channelId} does not support JSON login mode`);
    }
    setVerbose(Boolean(opts.verbose));
    const cfg = loadConfig();
    const accountId = opts.account?.trim() || resolveChannelDefaultAccountId({ plugin, cfg });
    const timeoutMs = opts.timeoutMs ?? 60000;

    // Start QR login and get QR data
    const startResult = await plugin.gateway.loginWithQrStart({
      accountId,
      force: false,
      timeoutMs,
      verbose: Boolean(opts.verbose),
    });

    // Output QR data as JSON
    const output = {
      status: "pending",
      qrDataUrl: startResult.qrDataUrl ?? null,
      message: startResult.message,
      accountId,
      channel: channelId,
    };
    runtime.log(JSON.stringify(output));

    // Wait for connection
    const waitResult = await plugin.gateway.loginWithQrWait({
      accountId,
      timeoutMs,
    });

    // Output final result
    const finalOutput = {
      status: waitResult.connected ? "connected" : "failed",
      connected: waitResult.connected,
      message: waitResult.message,
      accountId,
      channel: channelId,
    };
    runtime.log(JSON.stringify(finalOutput));
    return;
  }

  // Standard interactive mode
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
    throw new Error(`Unsupported channel: ${channelInput}`);
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
