import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { buildChannelUiCatalog } from "../../channels/plugins/catalog.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../../channels/plugins/types.js";
import type { MoltbotConfig } from "../../config/config.js";
import { loadConfig, readConfigFileSnapshot } from "../../config/config.js";
import { getChannelActivity } from "../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChannelsLogoutParams,
  validateChannelsStatusParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type ChannelLogoutPayload = {
  channel: ChannelId;
  accountId: string;
  cleared: boolean;
  [key: string]: unknown;
};

export async function logoutChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: MoltbotConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelLogoutPayload> {
  const resolvedAccountId =
    params.accountId?.trim() ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID;
  const account = params.plugin.config.resolveAccount(params.cfg, resolvedAccountId);
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const result = await params.plugin.gateway?.logoutAccount?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    account,
    runtime: defaultRuntime,
  });
  if (!result) {
    throw new Error(`Channel ${params.channelId} does not support logout`);
  }
  const cleared = Boolean(result.cleared);
  const loggedOut = typeof result.loggedOut === "boolean" ? result.loggedOut : cleared;
  if (loggedOut) {
    params.context.markChannelLoggedOut(params.channelId, true, resolvedAccountId);
  }
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    ...result,
    cleared,
  };
}

export const channelsHandlers: GatewayRequestHandlers = {
  "channels.status": async ({ params, respond, context }) => {
    if (!validateChannelsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.status params: ${formatValidationErrors(validateChannelsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const probe = (params as { probe?: boolean }).probe === true;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs = typeof timeoutMsRaw === "number" ? Math.max(1000, timeoutMsRaw) : 10_000;
    const cfg = loadConfig();
    const runtime = context.getRuntimeSnapshot();
    const plugins = listChannelPlugins();
    const pluginMap = new Map<ChannelId, ChannelPlugin>(
      plugins.map((plugin) => [plugin.id, plugin]),
    );

    const resolveRuntimeSnapshot = (
      channelId: ChannelId,
      accountId: string,
      defaultAccountId: string,
    ): ChannelAccountSnapshot | undefined => {
      const accounts = runtime.channelAccounts[channelId];
      const defaultRuntime = runtime.channels[channelId];
      const raw =
        accounts?.[accountId] ?? (accountId === defaultAccountId ? defaultRuntime : undefined);
      if (!raw) return undefined;
      return raw;
    };

    const isAccountEnabled = (plugin: ChannelPlugin, account: unknown) =>
      plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;

    const buildChannelAccounts = async (channelId: ChannelId) => {
      const plugin = pluginMap.get(channelId);
      if (!plugin) {
        return {
          accounts: [] as ChannelAccountSnapshot[],
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          defaultAccount: undefined as ChannelAccountSnapshot | undefined,
          resolvedAccounts: {} as Record<string, unknown>,
        };
      }
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: ChannelAccountSnapshot[] = [];
      const resolvedAccounts: Record<string, unknown> = {};
      for (const accountId of accountIds) {
        const account = plugin.config.resolveAccount(cfg, accountId);
        const enabled = isAccountEnabled(plugin, account);
        resolvedAccounts[accountId] = account;
        let probeResult: unknown;
        let lastProbeAt: number | null = null;
        if (probe && enabled && plugin.status?.probeAccount) {
          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await plugin.config.isConfigured(account, cfg);
          }
          if (configured) {
            probeResult = await plugin.status.probeAccount({
              account,
              timeoutMs,
              cfg,
            });
            lastProbeAt = Date.now();
          }
        }
        let auditResult: unknown;
        if (probe && enabled && plugin.status?.auditAccount) {
          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await plugin.config.isConfigured(account, cfg);
          }
          if (configured) {
            auditResult = await plugin.status.auditAccount({
              account,
              timeoutMs,
              cfg,
              probe: probeResult,
            });
          }
        }
        const runtimeSnapshot = resolveRuntimeSnapshot(channelId, accountId, defaultAccountId);
        const snapshot = await buildChannelAccountSnapshot({
          plugin,
          cfg,
          accountId,
          runtime: runtimeSnapshot,
          probe: probeResult,
          audit: auditResult,
        });
        if (lastProbeAt) snapshot.lastProbeAt = lastProbeAt;
        const activity = getChannelActivity({
          channel: channelId as never,
          accountId,
        });
        if (snapshot.lastInboundAt == null) {
          snapshot.lastInboundAt = activity.inboundAt;
        }
        if (snapshot.lastOutboundAt == null) {
          snapshot.lastOutboundAt = activity.outboundAt;
        }
        accounts.push(snapshot);
      }
      const defaultAccount =
        accounts.find((entry) => entry.accountId === defaultAccountId) ?? accounts[0];
      return { accounts, defaultAccountId, defaultAccount, resolvedAccounts };
    };

    const uiCatalog = buildChannelUiCatalog(plugins);
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      channelOrder: uiCatalog.order,
      channelLabels: uiCatalog.labels,
      channelDetailLabels: uiCatalog.detailLabels,
      channelSystemImages: uiCatalog.systemImages,
      channelMeta: uiCatalog.entries,
      channels: {} as Record<string, unknown>,
      channelAccounts: {} as Record<string, unknown>,
      channelDefaultAccountId: {} as Record<string, unknown>,
    };
    const channelsMap = payload.channels as Record<string, unknown>;
    const accountsMap = payload.channelAccounts as Record<string, unknown>;
    const defaultAccountIdMap = payload.channelDefaultAccountId as Record<string, unknown>;
    for (const plugin of plugins) {
      const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
        await buildChannelAccounts(plugin.id);
      const fallbackAccount =
        resolvedAccounts[defaultAccountId] ?? plugin.config.resolveAccount(cfg, defaultAccountId);
      const summary = plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account: fallbackAccount,
            cfg,
            defaultAccountId,
            snapshot:
              defaultAccount ??
              ({
                accountId: defaultAccountId,
              } as ChannelAccountSnapshot),
          })
        : {
            configured: defaultAccount?.configured ?? false,
          };
      channelsMap[plugin.id] = summary;
      accountsMap[plugin.id] = accounts;
      defaultAccountIdMap[plugin.id] = defaultAccountId;
    }

    respond(true, payload, undefined);
  },
  "channels.logout": async ({ params, respond, context }) => {
    if (!validateChannelsLogoutParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.logout params: ${formatValidationErrors(validateChannelsLogoutParams.errors)}`,
        ),
      );
      return;
    }
    const rawChannel = (params as { channel?: unknown }).channel;
    const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
    if (!channelId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.logout channel"),
      );
      return;
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.gateway?.logoutAccount) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support logout`),
      );
      return;
    }
    const accountIdRaw = (params as { accountId?: unknown }).accountId;
    const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : undefined;
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"),
      );
      return;
    }
    try {
      const payload = await logoutChannelAccount({
        channelId,
        accountId,
        cfg: snapshot.config ?? {},
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
