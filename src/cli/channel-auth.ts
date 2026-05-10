import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../channels/plugins/index.js";
import { resolveInstallableChannelPlugin } from "../commands/channel-setup/channel-plugin-resolution.js";
import { getRuntimeConfig, readConfigFileSnapshot, type OpenClawConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { callGateway } from "../gateway/call.js";
import { setVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { formatCliCommand } from "./command-format.js";
import { formatUnsupportedChannelActionMessage } from "./error-format.js";
import { commitConfigWithPendingPluginInstalls } from "./plugins-install-record-commit.js";

type ChannelAuthOptions = {
  channel?: string;
  account?: string;
  verbose?: boolean;
};

type ChannelPlugin = NonNullable<ReturnType<typeof getChannelPlugin>>;
type ChannelAuthMode = "login" | "logout";

function supportsChannelAuthMode(plugin: ChannelPlugin, mode: ChannelAuthMode): boolean {
  return mode === "login" ? Boolean(plugin.auth?.login) : Boolean(plugin.gateway?.logoutAccount);
}

function isConfiguredAuthPlugin(plugin: ChannelPlugin, cfg: OpenClawConfig): boolean {
  const key = plugin.id;
  if (isBlockedObjectKey(key)) {
    return false;
  }
  const channelCfg = (cfg.channels as Record<string, unknown> | undefined)?.[key];
  if (
    channelCfg &&
    typeof channelCfg === "object" &&
    "enabled" in channelCfg &&
    (channelCfg as { enabled?: unknown }).enabled === false
  ) {
    return false;
  }

  for (const accountId of plugin.config.listAccountIds(cfg)) {
    try {
      const account = plugin.config.resolveAccount(cfg, accountId);
      const enabled = plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : account && typeof account === "object"
          ? ((account as { enabled?: boolean }).enabled ?? true)
          : true;
      if (enabled) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

function resolveConfiguredAuthChannelInput(cfg: OpenClawConfig, mode: ChannelAuthMode): string {
  const configured = listChannelPlugins()
    .filter((plugin): plugin is ChannelPlugin => supportsChannelAuthMode(plugin, mode))
    .filter((plugin) => isConfiguredAuthPlugin(plugin, cfg))
    .map((plugin) => plugin.id);

  if (configured.length === 1) {
    return configured[0];
  }
  if (configured.length === 0) {
    throw new Error(
      `No configured channel supports ${mode}. Run ${formatCliCommand("openclaw channels status")} to inspect channels or ${formatCliCommand("openclaw channels add --channel <channel>")} to add one.`,
    );
  }
  const safeIds = configured.map(sanitizeForLog);
  throw new Error(
    `Multiple configured channels support ${mode}: ${safeIds.join(", ")}. Choose one with --channel <channel>.`,
  );
}

async function resolveChannelPluginForMode(
  opts: ChannelAuthOptions,
  mode: ChannelAuthMode,
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<{
  cfg: OpenClawConfig;
  configChanged: boolean;
  channelInput: string;
  channelId: string;
  plugin: ChannelPlugin;
}> {
  const explicitChannel = opts.channel?.trim();
  const channelInput = explicitChannel || resolveConfiguredAuthChannelInput(cfg, mode);
  const normalizedChannelId = normalizeChannelId(channelInput);

  const resolved = await resolveInstallableChannelPlugin({
    cfg,
    runtime,
    rawChannel: channelInput,
    ...(normalizedChannelId ? { channelId: normalizedChannelId } : {}),
    allowInstall: true,
    supports: (candidate) => supportsChannelAuthMode(candidate, mode),
  });
  const channelId = resolved.channelId ?? normalizedChannelId;
  if (!channelId) {
    throw new Error(
      `Unsupported channel "${channelInput}". Run ${formatCliCommand("openclaw channels list")} to see available channels.`,
    );
  }
  const plugin = resolved.plugin;
  if (!plugin || !supportsChannelAuthMode(plugin, mode)) {
    throw new Error(
      formatUnsupportedChannelActionMessage({
        channel: channelId,
        action: mode,
        inspectCommand: "openclaw channels status --channel " + channelId,
      }),
    );
  }
  return {
    cfg: resolved.cfg,
    configChanged: resolved.configChanged,
    channelInput,
    channelId,
    plugin,
  };
}

function resolveAccountContext(
  plugin: ChannelPlugin,
  opts: ChannelAuthOptions,
  cfg: OpenClawConfig,
) {
  const accountId =
    normalizeOptionalString(opts.account) || resolveChannelDefaultAccountId({ plugin, cfg });
  return { accountId };
}

async function reconcileGatewayRuntimeAfterLocalLogin(params: {
  cfg: OpenClawConfig;
  plugin: ChannelPlugin;
  channelId: string;
  accountId: string;
  runtime: RuntimeEnv;
}) {
  if (!params.plugin.gateway?.startAccount) {
    return;
  }
  if (params.cfg.gateway?.mode === "remote") {
    params.runtime.log(
      `Gateway is in remote mode; local login saved auth for ${params.channelId}/${params.accountId} but did not start the remote runtime.`,
    );
    return;
  }
  try {
    await callGateway({
      config: params.cfg,
      method: "channels.start",
      params: {
        channel: params.channelId,
        accountId: params.accountId,
      },
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      deviceIdentity: null,
    });
  } catch (error) {
    params.runtime.log(
      `Local login saved auth for ${params.channelId}/${params.accountId}, but the running gateway did not restart it: ${formatErrorMessage(error)}`,
    );
  }
}

async function logoutViaGatewayRuntime(params: {
  cfg: OpenClawConfig;
  channelId: string;
  accountId: string;
  runtime: RuntimeEnv;
}): Promise<boolean> {
  try {
    await callGateway({
      config: params.cfg,
      method: "channels.logout",
      params: {
        channel: params.channelId,
        accountId: params.accountId,
      },
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      deviceIdentity: null,
    });
    return true;
  } catch (error) {
    if (params.cfg.gateway?.mode === "remote") {
      throw error;
    }
    params.runtime.log(
      `Local logout will clear auth for ${params.channelId}/${params.accountId}, but the running gateway did not stop it: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}

export async function runChannelLogin(
  opts: ChannelAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
  const autoEnabled = applyPluginAutoEnable({
    config: getRuntimeConfig(),
    env: process.env,
  });
  const loadedCfg = autoEnabled.config;
  const resolvedChannel = await resolveChannelPluginForMode(opts, "login", loadedCfg, runtime);
  let cfg = resolvedChannel.cfg;
  const { configChanged, channelInput, plugin } = resolvedChannel;
  if (autoEnabled.changes.length > 0 || configChanged) {
    const committed = await commitConfigWithPendingPluginInstalls({
      nextConfig: cfg,
      baseHash: (await sourceSnapshotPromise)?.hash,
    });
    cfg = committed.config;
  }
  const login = plugin.auth?.login;
  if (!login) {
    throw new Error(
      formatUnsupportedChannelActionMessage({
        channel: channelInput,
        action: "login",
        inspectCommand: "openclaw channels status --channel " + channelInput,
      }),
    );
  }
  // Auth-only flow: do not mutate channel config here.
  setVerbose(Boolean(opts.verbose));
  const { accountId } = resolveAccountContext(plugin, opts, cfg);
  await login({
    cfg,
    accountId,
    runtime,
    verbose: Boolean(opts.verbose),
    channelInput,
  });
  await reconcileGatewayRuntimeAfterLocalLogin({
    cfg,
    plugin,
    channelId: plugin.id,
    accountId,
    runtime,
  });
}

export async function runChannelLogout(
  opts: ChannelAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
  const autoEnabled = applyPluginAutoEnable({
    config: getRuntimeConfig(),
    env: process.env,
  });
  const loadedCfg = autoEnabled.config;
  const resolvedChannel = await resolveChannelPluginForMode(opts, "logout", loadedCfg, runtime);
  let cfg = resolvedChannel.cfg;
  const { configChanged, channelInput, plugin } = resolvedChannel;
  if (autoEnabled.changes.length > 0 || configChanged) {
    const committed = await commitConfigWithPendingPluginInstalls({
      nextConfig: cfg,
      baseHash: (await sourceSnapshotPromise)?.hash,
    });
    cfg = committed.config;
  }
  const logoutAccount = plugin.gateway?.logoutAccount;
  if (!logoutAccount) {
    throw new Error(
      formatUnsupportedChannelActionMessage({
        channel: channelInput,
        action: "logout",
        inspectCommand: "openclaw channels status --channel " + channelInput,
      }),
    );
  }
  // Prefer the live gateway so logout also stops any active channel runtime.
  const { accountId } = resolveAccountContext(plugin, opts, cfg);
  if (
    await logoutViaGatewayRuntime({
      cfg,
      channelId: plugin.id,
      accountId,
      runtime,
    })
  ) {
    return;
  }
  const account = plugin.config.resolveAccount(cfg, accountId);
  await logoutAccount({
    cfg,
    accountId,
    account,
    runtime,
  });
}
