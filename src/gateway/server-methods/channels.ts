import { buildChannelUiCatalog } from "../../channels/plugins/catalog.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getChannelActivity } from "../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
} from "../channel-health-policy.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChannelsStartParams,
  validateChannelsStopParams,
  validateChannelsLogoutParams,
  validateChannelsStatusParams,
} from "../protocol/index.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type ChannelLogoutPayload = {
  channel: ChannelId;
  accountId: string;
  cleared: boolean;
  [key: string]: unknown;
};

type ChannelStartPayload = {
  channel: ChannelId;
  accountId: string;
  started: boolean;
};

type ChannelStopPayload = {
  channel: ChannelId;
  accountId: string;
  stopped: boolean;
};

const CHANNEL_STATUS_MAX_TIMEOUT_MS = 30_000;
const CHANNEL_STATUS_PROBE_CONCURRENCY = 5;

function resolveChannelsStatusTimeoutMs(params: { probe: boolean; timeoutMsRaw: unknown }): number {
  const fallback = params.probe ? CHANNEL_STATUS_MAX_TIMEOUT_MS : 10_000;
  if (typeof params.timeoutMsRaw !== "number" || !Number.isFinite(params.timeoutMsRaw)) {
    return fallback;
  }
  return Math.min(Math.max(1000, params.timeoutMsRaw), CHANNEL_STATUS_MAX_TIMEOUT_MS);
}

function resolveRuntimeAccountSnapshot(params: {
  runtime: ChannelRuntimeSnapshot;
  channelId: ChannelId;
  accountId: string;
}): ChannelAccountSnapshot | undefined {
  const accounts = params.runtime.channelAccounts[params.channelId];
  const direct = accounts?.[params.accountId];
  if (direct) {
    return direct;
  }
  const fallback = params.runtime.channels[params.channelId];
  return fallback?.accountId === params.accountId ? fallback : undefined;
}

function resolveChannelGatewayAccountId(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string {
  return (
    normalizeOptionalString(params.accountId) ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID
  );
}

export async function logoutChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelLogoutPayload> {
  const resolvedAccountId = resolveChannelGatewayAccountId(params);
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
  const cleared = result.cleared;
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

export async function startChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelStartPayload> {
  if (!params.plugin.gateway?.startAccount) {
    throw new Error(`Channel ${params.channelId} does not support runtime start`);
  }
  const resolvedAccountId = resolveChannelGatewayAccountId(params);
  await params.context.startChannel(params.channelId, resolvedAccountId);
  const runtime = params.context.getRuntimeSnapshot();
  const started =
    resolveRuntimeAccountSnapshot({
      runtime,
      channelId: params.channelId,
      accountId: resolvedAccountId,
    })?.running === true;
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    started,
  };
}

export async function stopChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelStopPayload> {
  const resolvedAccountId = resolveChannelGatewayAccountId(params);
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const runtime = params.context.getRuntimeSnapshot();
  const stopped =
    resolveRuntimeAccountSnapshot({
      runtime,
      channelId: params.channelId,
      accountId: resolvedAccountId,
    })?.running !== true;
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    stopped,
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
    const timeoutMs = resolveChannelsStatusTimeoutMs({ probe, timeoutMsRaw });
    const cfg = applyPluginAutoEnable({
      config: context.getRuntimeConfig(),
      env: process.env,
    }).config;
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
      if (!raw) {
        return undefined;
      }
      return raw;
    };

    const isAccountEnabled = (plugin: ChannelPlugin, account: unknown) =>
      plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;

    const buildAccountSnapshot = async (
      channelId: ChannelId,
      plugin: ChannelPlugin,
      accountId: string,
      defaultAccountId: string,
    ) => {
      const account = plugin.config.resolveAccount(cfg, accountId);
      const enabled = isAccountEnabled(plugin, account);
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
      if (lastProbeAt) {
        snapshot.lastProbeAt = lastProbeAt;
      }
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
      const health = evaluateChannelHealth(snapshot, {
        channelId,
        now: Date.now(),
        staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
        channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
      });
      if (!health.healthy) {
        snapshot.healthState = health.reason;
      }
      return { accountId: accountId, account, snapshot };
    };

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
      const resolvedAccounts: Record<string, unknown> = {};
      const { results } = await runTasksWithConcurrency({
        tasks: accountIds.map(
          (accountId) => async () =>
            await buildAccountSnapshot(channelId, plugin, accountId, defaultAccountId),
        ),
        limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : accountIds.length || 1,
      });
      const accounts: ChannelAccountSnapshot[] = [];
      for (const result of results) {
        if (result) {
          resolvedAccounts[result.accountId] = result.account;
          accounts.push(result.snapshot);
        }
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
      ...(context.getEventLoopHealth ? { eventLoop: context.getEventLoopHealth() } : {}),
      channels: {} as Record<string, unknown>,
      channelAccounts: {} as Record<string, unknown>,
      channelDefaultAccountId: {} as Record<string, unknown>,
    };
    const channelsMap = payload.channels as Record<string, unknown>;
    const accountsMap = payload.channelAccounts as Record<string, unknown>;
    const defaultAccountIdMap = payload.channelDefaultAccountId as Record<string, unknown>;
    const { results: channelResults } = await runTasksWithConcurrency({
      tasks: plugins.map((plugin) => async () => {
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
        return { pluginId: plugin.id, summary, accounts, defaultAccountId };
      }),
      limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : plugins.length || 1,
    });
    for (const result of channelResults) {
      if (result) {
        channelsMap[result.pluginId] = result.summary;
        accountsMap[result.pluginId] = result.accounts;
        defaultAccountIdMap[result.pluginId] = result.defaultAccountId;
      }
    }

    respond(true, payload, undefined);
  },
  "channels.start": async ({ params, respond, context }) => {
    if (!validateChannelsStartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.start params: ${formatValidationErrors(validateChannelsStartParams.errors)}`,
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
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.start channel"),
      );
      return;
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel: ${formatForLog(rawChannel)}`),
      );
      return;
    }
    if (!plugin.gateway?.startAccount) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support start`),
      );
      return;
    }
    try {
      const cfg = applyPluginAutoEnable({
        config: context.getRuntimeConfig(),
        env: process.env,
      }).config;
      const payload = await startChannelAccount({
        channelId,
        accountId: (params as { accountId?: string | null }).accountId,
        cfg,
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
  "channels.stop": async ({ params, respond, context }) => {
    if (!validateChannelsStopParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.stop params: ${formatValidationErrors(validateChannelsStopParams.errors)}`,
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
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.stop channel"),
      );
      return;
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel ${channelId}`),
      );
      return;
    }
    const accountIdRaw = (params as { accountId?: unknown }).accountId;
    const accountId = normalizeOptionalString(accountIdRaw);
    try {
      const payload = await stopChannelAccount({
        channelId,
        accountId,
        cfg: context.getRuntimeConfig(),
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
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
    const accountId = normalizeOptionalString(accountIdRaw);
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
        cfg: context.getRuntimeConfig(),
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
