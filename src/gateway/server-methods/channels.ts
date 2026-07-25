// Gateway RPC handlers for channel lifecycle, status, and account operations.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChannelsStartParams,
  validateChannelsStopParams,
  validateChannelsLogoutParams,
  validateChannelsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { redactChannelStatusSummaryBaseUrl } from "../../channels/account-snapshot-fields.js";
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
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getChannelActivity } from "../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
} from "../channel-health-policy.js";
import { resolveGatewayPluginConfig } from "../runtime-plugin-config.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

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

type ChannelOperationParams = {
  channel?: unknown;
  accountId?: unknown;
};

function resolveChannelOperationParams<TParams extends ChannelOperationParams>(params: {
  method: string;
  rawParams: unknown;
  respond: RespondFn;
  validate: Validator<TParams>;
}): { params: TParams; rawChannel: unknown; channelId: ChannelId } | null {
  const rawParams = params.rawParams;
  if (!assertValidParams(rawParams, params.validate, params.method, params.respond)) {
    return null;
  }
  const rawChannel = rawParams.channel;
  const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
  if (!channelId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${params.method} channel`),
    );
    return null;
  }
  return { params: rawParams, rawChannel, channelId };
}

async function respondWithChannelOperationPayload<TPayload>(params: {
  respond: RespondFn;
  run: () => Promise<TPayload>;
}): Promise<void> {
  try {
    params.respond(true, await params.run(), undefined);
  } catch (error) {
    params.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
  }
}

const CHANNEL_STATUS_MAX_TIMEOUT_MS = 30_000;
const CHANNEL_STATUS_PROBE_CONCURRENCY = 5;

function channelStatusTimeoutPayload(step: string, timeoutMs: number): Record<string, unknown> {
  return {
    ok: false,
    timedOut: true,
    error: `${step} timed out after ${timeoutMs}ms`,
  };
}

type TimeoutRaceResult<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

async function raceWithTimeout<T>(params: {
  timeoutMs: number;
  run: () => Promise<T> | T;
}): Promise<TimeoutRaceResult<T>> {
  const timeoutMs = params.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });
  const result = await Promise.race([
    Promise.resolve()
      .then(params.run)
      .then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
    timeout,
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

async function runChannelStatusHook(params: {
  accountId: string;
  channelId: ChannelId;
  step: "audit" | "probe";
  timeoutMs: number;
  warnings: string[];
  run: () => Promise<unknown>;
}): Promise<unknown> {
  const timeoutMs = Math.max(1, params.timeoutMs);
  // Channel probes come from plugin code and external services. Convert slow or
  // failing hooks into partial status data so one channel cannot block the UI.
  const result = await raceWithTimeout({
    timeoutMs,
    run: params.run,
  });
  if (result.kind === "value") {
    return result.value;
  }
  const warningPrefix = `${params.channelId}:${params.accountId} ${params.step}`;
  if (result.kind === "timeout") {
    params.warnings.push(`${warningPrefix} timed out after ${timeoutMs}ms`);
    return channelStatusTimeoutPayload(params.step, timeoutMs);
  }
  const message = formatForLog(result.error);
  params.warnings.push(`${warningPrefix} failed: ${message}`);
  return {
    ok: false,
    error: message,
  };
}

type Summary = { ok: true; value: unknown } | { ok: false; error: string; timedOut?: boolean };

async function runChannelStatusSummary(params: {
  channelId: ChannelId;
  timeoutMs: number;
  warnings: string[];
  run: () => unknown;
}): Promise<Summary> {
  const timeoutMs = Math.max(1, params.timeoutMs);
  const result = await raceWithTimeout({
    timeoutMs,
    run: params.run,
  });
  const warningPrefix = `${params.channelId} summary`;
  if (result.kind === "value") {
    // Summary hooks return the final public record, after account snapshot sanitization.
    return { ok: true, value: redactChannelStatusSummaryBaseUrl(result.value) };
  }
  if (result.kind === "timeout") {
    const error = `summary timed out after ${timeoutMs}ms`;
    params.warnings.push(`${warningPrefix} timed out after ${timeoutMs}ms`);
    return { ok: false, timedOut: true, error };
  }
  const message = formatForLog(result.error);
  params.warnings.push(`${warningPrefix} failed: ${message}`);
  return { ok: false, error: message };
}

function channelStatusFailureMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.ok !== false || typeof record.error !== "string" || record.error.length === 0) {
    return null;
  }
  return record.error;
}

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
  // Runtime operations use the same account precedence as channel setup:
  // explicit request, plugin default, first configured account, then fallback.
  return (
    normalizeOptionalString(params.accountId) ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID
  );
}

/** Log out one channel account through its owning channel plugin. */
async function logoutChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelLogoutPayload> {
  const resolvedAccountId = resolveChannelGatewayAccountId(params);
  const account = params.plugin.config.resolveAccount(params.cfg, resolvedAccountId);
  // Stop the runtime before clearing channel-owned auth so no active watcher can
  // immediately reconnect with credentials the user is trying to remove.
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

/** Start one channel account through its owning channel plugin. */
async function startChannelAccount(params: {
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
  await params.context.startChannel(params.channelId, resolvedAccountId, { manual: true });
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

/** Stop one channel account through its owning channel plugin. */
async function stopChannelAccount(params: {
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

/** Gateway request handlers for channel list, status, start, stop, and logout. */
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
    const rawChannel = (params as { channel?: unknown }).channel;
    const requestedChannel =
      typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : undefined;
    const runtimeConfig = context.getRuntimeConfig();
    const cfg = resolveGatewayPluginConfig({
      config: runtimeConfig,
    });
    const runtime = context.getRuntimeSnapshot();
    const plugins = listChannelPlugins();
    const selectedPlugins = requestedChannel
      ? plugins.filter((plugin) => plugin.id === requestedChannel)
      : plugins;
    if (rawChannel !== undefined && !requestedChannel) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel: ${formatForLog(rawChannel)}`),
      );
      return;
    }
    const pluginMap = new Map<ChannelId, ChannelPlugin>(
      selectedPlugins.map((plugin) => [plugin.id, plugin]),
    );
    const statusWarnings: string[] = [];

    const resolveRuntimeSnapshot = (
      channelId: ChannelId,
      accountId: string,
      defaultAccountId: string,
    ): ChannelAccountSnapshot | undefined => {
      const accounts = runtime.channelAccounts[channelId];
      const defaultRuntimeLocal = runtime.channels[channelId];
      const raw =
        accounts?.[accountId] ?? (accountId === defaultAccountId ? defaultRuntimeLocal : undefined);
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
        // Skip expensive probes for accounts that are not configured; the
        // snapshot builder still reports the config state below.
        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (configured) {
          probeResult = await runChannelStatusHook({
            channelId,
            accountId,
            step: "probe",
            timeoutMs,
            warnings: statusWarnings,
            run: () =>
              plugin.status!.probeAccount!({
                account,
                timeoutMs,
                cfg,
              }),
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
          auditResult = await runChannelStatusHook({
            channelId,
            accountId,
            step: "audit",
            timeoutMs,
            warnings: statusWarnings,
            run: () =>
              plugin.status!.auditAccount!({
                account,
                timeoutMs,
                cfg,
                probe: probeResult,
              }),
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
      const hookError =
        channelStatusFailureMessage(auditResult) ?? channelStatusFailureMessage(probeResult);
      if (hookError && !snapshot.lastError) {
        snapshot.lastError = hookError;
      }
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
      return { accountId, account, snapshot };
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

    const uiCatalog = buildChannelUiCatalog(selectedPlugins);
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
      tasks: selectedPlugins.map((plugin) => async () => {
        const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
          await buildChannelAccounts(plugin.id);
        const fallbackAccount =
          resolvedAccounts[defaultAccountId] ?? plugin.config.resolveAccount(cfg, defaultAccountId);
        const fallbackSummary = (lastError?: string) => ({
          configured: defaultAccount?.configured ?? false,
          ...(lastError ? { lastError } : {}),
        });
        let summary: unknown = fallbackSummary();
        if (plugin.status?.buildChannelSummary) {
          const summaryResult = await runChannelStatusSummary({
            channelId: plugin.id,
            timeoutMs,
            warnings: statusWarnings,
            run: () =>
              plugin.status!.buildChannelSummary!({
                account: fallbackAccount,
                cfg,
                defaultAccountId,
                snapshot:
                  defaultAccount ??
                  ({
                    accountId: defaultAccountId,
                  } as ChannelAccountSnapshot),
              }),
          });
          summary = summaryResult.ok ? summaryResult.value : fallbackSummary(summaryResult.error);
        }
        return { pluginId: plugin.id, summary, accounts, defaultAccountId };
      }),
      limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : selectedPlugins.length || 1,
    });
    for (const result of channelResults) {
      if (result) {
        channelsMap[result.pluginId] = result.summary;
        accountsMap[result.pluginId] = result.accounts;
        defaultAccountIdMap[result.pluginId] = result.defaultAccountId;
      }
    }
    if (statusWarnings.length > 0) {
      payload.partial = true;
      payload.warnings = statusWarnings.slice(0, 50);
    }

    respond(true, payload, undefined);
  },
  "channels.start": async ({ params, respond, context }) => {
    const resolved = resolveChannelOperationParams({
      method: "channels.start",
      rawParams: params,
      respond,
      validate: validateChannelsStartParams,
    });
    if (!resolved) {
      return;
    }
    const { params: parsedParams, rawChannel, channelId } = resolved;
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
    await respondWithChannelOperationPayload({
      respond,
      run: () =>
        startChannelAccount({
          channelId,
          accountId: parsedParams.accountId,
          cfg: resolveGatewayPluginConfig({
            config: context.getRuntimeConfig(),
          }),
          context,
          plugin,
        }),
    });
  },
  "channels.stop": async ({ params, respond, context }) => {
    const resolved = resolveChannelOperationParams({
      method: "channels.stop",
      rawParams: params,
      respond,
      validate: validateChannelsStopParams,
    });
    if (!resolved) {
      return;
    }
    const { params: parsedParams, channelId } = resolved;
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel ${channelId}`),
      );
      return;
    }
    const accountId = normalizeOptionalString(parsedParams.accountId);
    await respondWithChannelOperationPayload({
      respond,
      run: () =>
        stopChannelAccount({
          channelId,
          accountId,
          cfg: context.getRuntimeConfig(),
          context,
          plugin,
        }),
    });
  },
  "channels.logout": async ({ params, respond, context }) => {
    const resolved = resolveChannelOperationParams({
      method: "channels.logout",
      rawParams: params,
      respond,
      validate: validateChannelsLogoutParams,
    });
    if (!resolved) {
      return;
    }
    const { params: parsedParams, channelId } = resolved;
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.gateway?.logoutAccount) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support logout`),
      );
      return;
    }
    const accountId = normalizeOptionalString(parsedParams.accountId);
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"),
      );
      return;
    }
    await respondWithChannelOperationPayload({
      respond,
      run: () =>
        logoutChannelAccount({
          channelId,
          accountId,
          cfg: context.getRuntimeConfig(),
          context,
          plugin,
        }),
    });
  },
};
