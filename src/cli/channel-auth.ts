import { expectDefined } from "@openclaw/normalization-core";
// Channel login/logout command helpers for local config and gateway reconciliation.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../channels/plugins/index.js";
import { resolveInstallableChannelPlugin } from "../commands/channel-setup/channel-plugin-resolution.js";
import { assertAccountSelectorForMutation } from "../commands/channels/account-selector.js";
import { requireValidConfigForWrite } from "../commands/config-validation.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { callGateway } from "../gateway/call.js";
import type { ChannelAccountStartOutcome } from "../gateway/server-channel-runtime.types.js";
import { setVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { commitConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { formatCliCommand } from "./command-format.js";
import { formatUnsupportedChannelActionMessage } from "./error-format.js";

type ChannelAuthOptions = {
  agent?: string;
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

function resolveConfiguredAuthChannelInput(mode: ChannelAuthMode): string {
  // Account callbacks need runtime values; this auto-enabled view is never persisted.
  const cfg = applyPluginAutoEnable({ config: getRuntimeConfig(), env: process.env }).config;
  const configured = listChannelPlugins()
    .filter((plugin): plugin is ChannelPlugin => supportsChannelAuthMode(plugin, mode))
    .filter((plugin) => isConfiguredAuthPlugin(plugin, cfg))
    .map((plugin) => plugin.id);

  if (configured.length === 1) {
    return expectDefined(configured[0], "configured entry at 0");
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
  runtime: RuntimeEnv,
): Promise<{
  cfg: OpenClawConfig;
  channelInput: string;
  channelId: string;
  plugin: ChannelPlugin;
} | null> {
  assertAccountSelectorForMutation(opts.account);
  const writeSnapshot = await requireValidConfigForWrite(runtime);
  if (!writeSnapshot) {
    return null;
  }
  // Runtime defaults are not authored plugin enablement intent.
  const autoEnabled = applyPluginAutoEnable({
    config: writeSnapshot.snapshot.sourceConfig,
    env: process.env,
  });
  const cfg = autoEnabled.config;
  const explicitChannel = opts.channel?.trim();
  const channelInput = explicitChannel || resolveConfiguredAuthChannelInput(mode);
  const normalizedChannelId = normalizeChannelId(channelInput);

  const resolved = await resolveInstallableChannelPlugin({
    cfg,
    runtime,
    agentId: opts.agent,
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
  if (autoEnabled.changes.length > 0 || resolved.configChanged) {
    await commitConfigWithPendingPluginInstalls({
      sourceConfig: resolved.cfg,
      baseHash: writeSnapshot.snapshot.hash,
      writeOptions: writeSnapshot.writeOptions,
    });
  }
  return {
    // Execution needs resolved runtime values; successful writes refresh this snapshot.
    cfg: getRuntimeConfig(),
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

function isChannelMissingFromGatewayRegistry(error: unknown): error is Error {
  const requestError = error as (Error & { gatewayCode?: unknown }) | undefined;
  return (
    requestError instanceof Error &&
    requestError.name === "GatewayClientRequestError" &&
    requestError.gatewayCode === "INVALID_REQUEST" &&
    requestError.message === "invalid channels.start channel"
  );
}

async function reconcileGatewayRuntimeAfterLocalLogin(params: {
  cfg: OpenClawConfig;
  plugin: ChannelPlugin;
  channelId: string;
  accountId: string;
  runtime: RuntimeEnv;
}) {
  // Local auth writes are durable even when the gateway restart hook is unavailable or remote.
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
    const result = await callGateway<{ outcome?: ChannelAccountStartOutcome }>({
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
    // Older Gateways return only the runtime snapshot, without a start decision.
    if (result.outcome && result.outcome.status !== "handed-off") {
      params.runtime.log(
        `Local login saved auth for ${params.channelId}/${params.accountId}. Gateway start: ${result.outcome.reason}. Check ${formatCliCommand(`openclaw channels status --channel ${params.channelId} --probe`)}.`,
      );
    }
  } catch (error) {
    // A plugin installed or enabled after Gateway startup is absent from its
    // process-stable registry. Restart only for that exact RPC rejection.
    if (isChannelMissingFromGatewayRegistry(error)) {
      try {
        await callGateway({
          config: params.cfg,
          method: "gateway.restart.request",
          params: { reason: `channel login: load ${params.channelId}` },
          mode: GATEWAY_CLIENT_MODES.BACKEND,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          deviceIdentity: null,
        });
        params.runtime.log(
          `Gateway restart requested to load ${params.channelId}; the channel will start after restart.`,
        );
        return;
      } catch {
        // Fall through to the generic warning if the restart request also fails.
      }
    }
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
}) {
  try {
    return await callGateway<{ cleared: boolean; loggedOut?: boolean }>({
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
  } catch (error) {
    if (params.cfg.gateway?.mode === "remote") {
      throw error;
    }
    params.runtime.log(
      `Local logout will clear auth for ${params.channelId}/${params.accountId}, but the running gateway did not stop it: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}

export async function runChannelLogin(
  opts: ChannelAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const resolvedChannel = await resolveChannelPluginForMode(opts, "login", runtime);
  if (!resolvedChannel) {
    return;
  }
  const { cfg, channelInput, plugin } = resolvedChannel;
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
  const resolvedChannel = await resolveChannelPluginForMode(opts, "logout", runtime);
  if (!resolvedChannel) {
    return;
  }
  const { cfg, channelInput, plugin } = resolvedChannel;
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
  let result = await logoutViaGatewayRuntime({
    cfg,
    channelId: plugin.id,
    accountId,
    runtime,
  });
  if (!result) {
    const account = plugin.config.resolveAccount(cfg, accountId);
    result = await logoutAccount({
      cfg,
      accountId,
      account,
      runtime,
    });
  }
  const scope = sanitizeForLog(`${plugin.id}/${accountId}`);
  runtime.log(
    `${result.cleared ? "Cleared saved auth" : "No saved auth was cleared"} for ${scope}.${
      result.loggedOut === false ? " Other credentials may still be active." : ""
    }`,
  );
}
