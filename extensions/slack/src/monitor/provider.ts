// Slack provider module implements model/runtime integration.
import type { IncomingMessage, ServerResponse } from "node:http";
import { type FetchFunction, type WebClientOptions, WebClient } from "@slack/web-api";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "openclaw/plugin-sdk/allow-from";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { SessionScope } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { normalizeMainKey } from "openclaw/plugin-sdk/routing";
import {
  warn,
  computeBackoff,
  createNonExitingRuntime,
  sleepWithAbort,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asNonArrayRecord,
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { installRequestBodyLimitGuard } from "openclaw/plugin-sdk/webhook-request-guards";
import {
  resolveSlackAccount,
  resolveSlackAccountAllowFrom,
  resolveSlackAccountDmPolicy,
} from "../accounts.js";
import { isSlackAnyNativeApprovalClientEnabled } from "../approval-native-gates.js";
import {
  resolveSlackLookupClientOptions,
  resolveSlackProxyDispatcher,
  resolveSlackWebClientOptions,
} from "../client-options.js";
import { createSlackStartupAuthClient, createSlackWebClient } from "../client.js";
import { normalizeSlackWebhookPath, registerSlackHttpHandler } from "../http/index.js";
import { registerSlackInstallationState } from "../installation-identity-state.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { resolveSlackChannelAllowlist } from "../resolve-channels.js";
import { resolveSlackUserAllowlist, type SlackUserResolution } from "../resolve-users.js";
import {
  formatSlackBotTokenIdentityWarning,
  resolveSlackAppToken,
  resolveSlackBotToken,
} from "../token.js";
import { normalizeAllowList } from "./allow-list.js";
import { resolveSlackSlashCommandConfig } from "./commands.js";
import {
  getRuntimeConfig,
  isDangerousNameMatchingEnabled,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./config.runtime.js";
import { createSlackMonitorContext, type SlackMonitorContext } from "./context.js";
import {
  assertEnterpriseSlackBindingsAreWorkspaceQualified,
  assertEnterpriseSlackPolicyConfig,
  resolveSlackIdentityHealth,
  resolveSlackInstallationIdentity,
  type SlackAuthTestIdentity,
  type SlackInstallationIdentity,
} from "./enterprise-install.js";
import { registerSlackCommonEvents, registerSlackWorkspaceEvents } from "./events.js";
import { createSlackDurableIngress } from "./ingress.js";
import { createSlackMessageHandler } from "./message-handler.js";
import { openSlackPresenceCooldownStore } from "./presence-cooldown-store.js";
import {
  createSlackPresenceMonitor,
  hasSlackPresenceEventsEnabled,
  SLACK_PRESENCE_REQUEST_TIMEOUT_MS,
} from "./presence-monitor.js";
import {
  createSlackBoltApp,
  formatSlackChannelResolved,
  formatSlackUserResolved,
  gracefulStopSlackApp,
  publishSlackConnectedStatus,
  publishSlackBlockedStatus,
  publishSlackDisconnectedStatus,
  resolveSlackBoltInterop,
  startSlackSocketAndWaitForDisconnect,
  type SlackBoltResolvedExports,
} from "./provider-support.js";
import {
  formatSlackSocketModeSharedConnectionWarning,
  formatUnknownError,
  isNonRecoverableSlackAuthError,
  registerSlackSocketModeConnectionDiagnostics,
  SLACK_SOCKET_RECONNECT_POLICY,
} from "./reconnect-policy.js";
import { setSlackDefaultSendIdentity } from "./send.runtime.js";
import { registerSlackMonitorSlashCommands } from "./slash.js";
import type { MonitorSlackOpts } from "./types.js";

let slackBoltInterop: SlackBoltResolvedExports | undefined;

function withSlackPresenceLifecycleSignal(
  fetchImpl: FetchFunction,
  lifecycleSignal: AbortSignal,
): FetchFunction {
  return async (input, init) =>
    await fetchImpl(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, lifecycleSignal]) : lifecycleSignal,
    });
}

async function getSlackBoltInterop(): Promise<SlackBoltResolvedExports> {
  if (!slackBoltInterop) {
    const slackBoltModule = await import("@slack/bolt");
    slackBoltInterop = resolveSlackBoltInterop({
      defaultImport: slackBoltModule.default,
      namespaceImport: slackBoltModule,
    });
  }
  return slackBoltInterop;
}

const loadSlackRelaySource = createLazyRuntimeModule(() => import("./relay-source.js"));

const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

type SlackRuntimeIdentity = {
  botUserId: string;
  botId?: string;
};

function resolveSlackRuntimeIdentity(params: {
  identity: "bot" | "user";
  botUserId?: unknown;
  botId?: unknown;
}): SlackRuntimeIdentity | undefined {
  // User identity has no bot_id; its human id is both the mention target and self-send dedupe
  // source. Bot identity stays bot_id-gated so token mismatches fail closed.
  const botUserId = normalizeOptionalString(params.botUserId);
  const botId = normalizeOptionalString(params.botId);
  if (!botUserId || (params.identity === "bot" && !botId)) {
    return undefined;
  }
  return {
    botUserId,
    ...(botId ? { botId } : {}),
  };
}

function applySlackInstallationIdentity(
  ctx: SlackMonitorContext,
  identity: SlackInstallationIdentity,
) {
  ctx.installationIdentity = identity;
  ctx.teamId = identity.kind === "workspace" ? identity.teamId : "";
  ctx.apiAppId = identity.kind === "degraded" ? "" : (identity.apiAppId ?? "");
}

function adoptSlackIdentity(params: {
  ctx: SlackMonitorContext;
  identity: "bot" | "user";
  installationIdentity: SlackInstallationIdentity;
  botUserId?: unknown;
  botId?: unknown;
}): boolean {
  if (
    params.ctx.identityHealth.lifecycle !== "blocked" ||
    params.installationIdentity.kind === "degraded"
  ) {
    return false;
  }
  const resolved = resolveSlackRuntimeIdentity(params);
  if (!resolved) {
    return false;
  }
  applySlackInstallationIdentity(params.ctx, params.installationIdentity);
  params.ctx.botUserId = resolved.botUserId;
  params.ctx.botId = resolved.botId;
  params.ctx.identityHealth = resolveSlackIdentityHealth({
    installationIdentity: params.installationIdentity,
    botUserId: resolved.botUserId,
  });
  return true;
}

function resolveStableSlackUserIdEntry(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const mention = /^<@([A-Z][A-Z0-9]+)>$/i.exec(trimmed);
  if (mention) {
    return mention[1]?.toUpperCase();
  }
  const prefixed = /^(?:slack:|user:)([A-Z][A-Z0-9]+)$/i.exec(trimmed);
  if (prefixed) {
    return prefixed[1]?.toUpperCase();
  }
  return /^[UW][A-Z0-9]+$/i.test(trimmed) ? trimmed.toUpperCase() : undefined;
}

function resolveStableSlackUserAllowlistEntries(entries: string[]): SlackUserResolution[] {
  const resolved: SlackUserResolution[] = [];
  for (const input of entries) {
    const id = resolveStableSlackUserIdEntry(input);
    if (id) {
      resolved.push({ input, resolved: true, id });
    }
  }
  return resolved;
}

function formatSlackSocketReconnectMessage(params: {
  event: string;
  attempt: number;
  delayMs: number;
  error?: unknown;
}) {
  const suffix = params.error ? ` (${formatUnknownError(params.error)})` : "";
  return `slack socket disconnected (${params.event}); reconnecting in ${Math.round(params.delayMs / 1000)}s (attempt ${params.attempt}/∞)${suffix}`;
}

function formatSlackSocketStartRetryMessage(params: {
  attempt: number;
  delayMs: number;
  error: unknown;
  sdkContext?: string;
}) {
  const reason = formatUnknownError(
    params.error,
    "Slack Socket Mode start failed without error detail",
  );
  const sdkContext = params.sdkContext?.trim() ? `; last SDK log: ${params.sdkContext.trim()}` : "";
  return `slack socket mode failed to start; retry ${params.attempt}/∞ in ${Math.round(params.delayMs / 1000)}s reason="${reason}${sdkContext}"`;
}

function parseApiAppIdFromAppToken(raw?: string) {
  const token = raw?.trim();
  if (!token) {
    return undefined;
  }
  const match = /^xapp-\d-([a-z0-9]+)-/i.exec(token);
  return match?.[1]?.toUpperCase();
}

function resolveSlackRelayConfig(params: { relay: unknown; accountId: string }): {
  url: string;
  authToken: string;
  gatewayId: string;
} {
  const relay = asNonArrayRecord(params.relay);
  const url = normalizeOptionalString(relay.url);
  const authToken = normalizeResolvedSecretInputString({
    value: relay.authToken,
    path: `channels.slack.accounts.${params.accountId}.relay.authToken`,
  });
  const gatewayId = normalizeOptionalString(relay.gatewayId);
  if (!url || !authToken || !gatewayId) {
    throw new Error(
      `Slack relay mode requires relay.url, relay.authToken, and relay.gatewayId for account "${params.accountId}".`,
    );
  }
  return {
    url,
    authToken,
    gatewayId,
  };
}

export async function monitorSlackProvider(opts: MonitorSlackOpts = {}) {
  const cfg = opts.config ?? getRuntimeConfig();
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.enabled) {
    runtime.log?.(`[${account.accountId}] slack account disabled; monitor startup skipped`);
    if (opts.abortSignal?.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      opts.abortSignal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    return;
  }

  const historyLimit = Math.max(
    0,
    account.config.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const dmHistoryLimit = Math.max(0, account.config.dmHistoryLimit ?? 0);

  const sessionCfg = cfg.session;
  const sessionScope: SessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);

  const slackMode = opts.mode ?? account.config.mode ?? "socket";
  const slackWebhookPath = normalizeSlackWebhookPath(account.config.webhookPath);
  const signingSecret =
    slackMode === "http"
      ? normalizeResolvedSecretInputString({
          value: account.config.signingSecret,
          path: `channels.slack.accounts.${account.accountId}.signingSecret`,
        })
      : undefined;
  const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
  const userToken = account.userToken;
  const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
  const relayConfig =
    slackMode === "relay"
      ? resolveSlackRelayConfig({
          relay: account.config.relay,
          accountId: account.accountId,
        })
      : undefined;
  let token: string;
  if (account.identity === "user") {
    if (!userToken) {
      throw new Error(
        `Slack user token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.userToken or SLACK_USER_TOKEN for default).`,
      );
    }
    if (slackMode === "socket" && !appToken) {
      throw new Error(
        `Slack app token missing for user-identity socket mode account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.appToken or SLACK_APP_TOKEN for default).`,
      );
    }
    if (slackMode === "http" && !signingSecret) {
      throw new Error(
        `Slack signing secret missing for user-identity HTTP mode account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`,
      );
    }
    token = userToken;
  } else {
    if (!botToken || (slackMode === "socket" && !appToken)) {
      const missing =
        slackMode === "http"
          ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).`
          : slackMode === "relay"
            ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).`
            : `Slack bot + app tokens missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`;
      throw new Error(missing);
    }
    if (slackMode === "http" && !signingSecret) {
      throw new Error(
        `Slack signing secret missing for account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`,
      );
    }
    token = botToken;
  }

  const slackCfg = account.config;
  const dmConfig = slackCfg.dm;

  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = resolveSlackAccountDmPolicy({ cfg, accountId: account.accountId }) ?? "pairing";
  let allowFrom = resolveSlackAccountAllowFrom({ cfg, accountId: account.accountId });
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  let channelsConfig = slackCfg.channels;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const providerConfigPresent = cfg.channels?.slack !== undefined;
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent,
    groupPolicy: slackCfg.groupPolicy,
    defaultGroupPolicy,
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "slack",
    accountId: account.accountId,
    log: (message) => runtime.log?.(warn(message)),
  });

  const resolveToken = account.userToken || botToken;
  const useAccessGroups = true;
  const reactionMode = slackCfg.reactionNotifications ?? "own";
  const reactionAllowlist = slackCfg.reactionAllowlist ?? [];
  const replyToMode = slackCfg.replyToMode ?? "off";
  const threadHistoryScope = slackCfg.thread?.historyScope ?? "thread";
  const threadInheritParent = slackCfg.thread?.inheritParent ?? false;
  const slashCommand = resolveSlackSlashCommandConfig(opts.slashCommand ?? slackCfg.slashCommand);
  const allowNameMatching = isDangerousNameMatchingEnabled(slackCfg);
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId, {
    fallbackLimit: SLACK_TEXT_LIMIT,
  });
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const typingReaction = slackCfg.typingReaction?.trim() ?? "";
  const mediaMaxBytes = (opts.mediaMaxMb ?? slackCfg.mediaMaxMb ?? 20) * 1024 * 1024;
  const slackDispatcher = resolveSlackProxyDispatcher();
  const clientOptions = resolveSlackWebClientOptions({}, slackDispatcher);
  const durableIngress = createSlackDurableIngress({
    accountId: account.accountId,
    ...(runtime.log ? { onLog: runtime.log } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
  const monitorContextRef: { current?: SlackMonitorContext } = {};
  const { app, receiver, socketModeLogger } = createSlackBoltApp({
    interop: await getSlackBoltInterop(),
    slackMode,
    token,
    appToken: slackMode === "socket" ? (appToken ?? undefined) : undefined,
    signingSecret: signingSecret ?? undefined,
    slackWebhookPath,
    clientOptions: clientOptions as Record<string, unknown>,
    dispatcher: slackDispatcher,
    wrapReceiver: durableIngress.wrapReceiver,
    onContextIdentity: async (identity) => {
      const current = monitorContextRef.current;
      if (!current) {
        return;
      }
      const recovered =
        current.identityHealth.lifecycle === "blocked" ? await recoverSlackIdentity() : false;
      const contextTeamId = normalizeOptionalString(identity.teamId);
      const contextEnterpriseId = normalizeOptionalString(identity.enterpriseId);
      const contextInstallationIdentity =
        identity.isEnterpriseInstall === false && contextTeamId
          ? ({
              kind: "workspace",
              teamId: contextTeamId,
              ...(contextEnterpriseId ? { enterpriseId: contextEnterpriseId } : {}),
            } satisfies SlackInstallationIdentity)
          : undefined;
      const adopted =
        current.identityHealth.lifecycle === "blocked" &&
        contextInstallationIdentity !== undefined &&
        adoptSlackIdentity({
          ctx: current,
          identity: account.identity,
          installationIdentity: contextInstallationIdentity,
          botUserId: identity.botUserId,
          botId: identity.botId,
        });
      if (adopted && contextInstallationIdentity) {
        installationState.update(contextInstallationIdentity.kind);
        await installSlackRuntimeForIdentity(contextInstallationIdentity);
      }
      if (recovered || adopted) {
        publishSlackConnectedStatus(opts.setStatus, current.identityHealth);
      }
    },
  });

  // Pre-set shuttingDown on the SocketModeClient before app.stop() to prevent
  // a race where the library's internal ping timeout fires disconnect() before
  // shuttingDown is set, causing orphaned reconnects with leaked ping intervals.
  // See: openclaw/openclaw#56508
  const gracefulStop = async () => {
    await gracefulStopSlackApp(app);
  };

  const slackHttpHandler =
    slackMode === "http" && receiver
      ? async (req: IncomingMessage, res: ServerResponse) => {
          const httpReceiver = receiver as {
            requestListener: (req: IncomingMessage, res: ServerResponse) => unknown;
          };
          const guard = installRequestBodyLimitGuard(req, res, {
            maxBytes: SLACK_WEBHOOK_MAX_BODY_BYTES,
            timeoutMs: SLACK_WEBHOOK_BODY_TIMEOUT_MS,
            responseFormat: "text",
          });
          if (guard.isTripped()) {
            return;
          }
          try {
            await Promise.resolve(httpReceiver.requestListener(req, res));
          } catch (err) {
            if (!guard.isTripped()) {
              throw err;
            }
          } finally {
            guard.dispose();
          }
        }
      : null;
  let unregisterHttpHandler: (() => void) | null = null;
  const unregisterSocketModeConnectionDiagnostics =
    slackMode === "socket"
      ? registerSlackSocketModeConnectionDiagnostics({
          app,
          onSharedConnection: (activeConnections) => {
            runtime.log?.(warn(formatSlackSocketModeSharedConnectionWarning(activeConnections)));
          },
        })
      : () => {};

  let botUserId = "";
  let botId = "";
  const expectedApiAppIdFromAppToken =
    slackMode === "socket" ? parseApiAppIdFromAppToken(appToken) : undefined;
  let authTestError: string | undefined;
  let authIdentityWarning: string | undefined;
  let authTestIdentity: SlackAuthTestIdentity | undefined;
  try {
    const auth = await createSlackStartupAuthClient(token, clientOptions).auth.test();
    const authUserId = normalizeOptionalString(auth.user_id) ?? "";
    const resolvedIdentity = resolveSlackRuntimeIdentity({
      identity: account.identity,
      botUserId: authUserId,
      botId: (auth as { bot_id?: string }).bot_id,
    });
    botUserId = resolvedIdentity?.botUserId ?? "";
    botId = resolvedIdentity?.botId ?? "";
    authTestIdentity = auth;
    if (account.identity === "bot") {
      authIdentityWarning = formatSlackBotTokenIdentityWarning({
        auth,
        accountId: account.accountId,
      });
    }
    if (!authUserId) {
      authTestError = "auth.test returned no user_id";
    }
  } catch (err) {
    authTestError = err instanceof Error ? err.message : String(err);
  }
  const assertSlackInstallationPolicy = (identity: SlackInstallationIdentity) => {
    if (identity.kind === "degraded") {
      if (slackMode === "relay") {
        throw new Error(
          `Slack relay account "${account.accountId}" requires a successful auth.test before startup`,
        );
      }
      return;
    }
    if (identity.kind !== "enterprise") {
      return;
    }
    if (slackMode === "relay") {
      throw new Error(
        `Slack Enterprise Grid org account "${account.accountId}" requires direct socket or HTTP delivery; relay mode is unsupported`,
      );
    }
    assertEnterpriseSlackPolicyConfig({ config: account.config, accountId: account.accountId });
    assertEnterpriseSlackBindingsAreWorkspaceQualified({ cfg, accountId: account.accountId });
  };
  const installationIdentity = resolveSlackInstallationIdentity({
    auth: authTestError === undefined ? authTestIdentity : undefined,
    transportApiAppId: expectedApiAppIdFromAppToken,
  });
  assertSlackInstallationPolicy(installationIdentity);
  const teamId = installationIdentity.kind === "workspace" ? installationIdentity.teamId : "";
  const apiAppId =
    installationIdentity.kind === "degraded" ? "" : (installationIdentity.apiAppId ?? "");
  if (authTestError !== undefined) {
    const identityFailureDetail =
      account.identity === "user"
        ? "explicit self-mention detection will be disabled while the user identity is unresolved"
        : "explicit bot-mention detection will be disabled while the bot identity is unresolved";
    runtime.log?.(
      warn(
        `[${account.accountId}] slack auth.test failed at boot (${authTestError}); ` +
          `${identityFailureDetail}; ` +
          "required-mention channels will fail closed without another trusted activation signal",
      ),
    );
  }
  if (authIdentityWarning) {
    runtime.log?.(warn(authIdentityWarning));
  }

  const identityHealth = resolveSlackIdentityHealth({
    installationIdentity,
    botUserId,
    authTestError,
    authIdentityWarning,
  });

  if (apiAppId && expectedApiAppIdFromAppToken && apiAppId !== expectedApiAppIdFromAppToken) {
    const identityTokenLabel = account.identity === "user" ? "user token" : "bot token";
    runtime.error?.(
      `slack token mismatch: ${identityTokenLabel} app_id=${apiAppId} but app token looks like app_id=${expectedApiAppIdFromAppToken}`,
    );
  }

  const ctx = createSlackMonitorContext({
    cfg,
    accountId: account.accountId,
    botToken: token,
    app,
    runtime,
    channelRuntime: opts.channelRuntime,
    botUserId,
    botId,
    identityHealth,
    teamId,
    apiAppId,
    installationIdentity,
    historyLimit,
    dmHistoryLimit,
    sessionScope,
    mainKey,
    dmEnabled,
    dmPolicy,
    allowFrom,
    allowNameMatching,
    groupDmEnabled,
    groupDmChannels,
    defaultRequireMention: slackCfg.requireMention,
    channelsConfig,
    groupPolicy,
    useAccessGroups,
    reactionMode,
    reactionAllowlist,
    replyToMode,
    threadHistoryScope,
    threadInheritParent,
    slashCommand,
    textLimit,
    ackReactionScope,
    typingReaction,
    mediaMaxBytes,
  });
  monitorContextRef.current = ctx;

  // Slack's socket-mode client keeps ping/pong health private and closes on
  // missed pongs. App events are useful status activity, but not transport proof.
  const trackEvent = opts.setStatus
    ? () => {
        opts.setStatus!({ lastEventAt: Date.now(), lastInboundAt: Date.now() });
      }
    : undefined;

  const presenceEventsEnabled = hasSlackPresenceEventsEnabled({
    account: slackCfg.presenceEvents,
    channels: slackCfg.channels,
  });
  let presenceRequestAbort: AbortController | undefined;
  let presenceMonitor: ReturnType<typeof createSlackPresenceMonitor> | undefined;
  let presenceMonitorStarted = false;
  let runtimeStarted = false;
  const startPresenceMonitor = () => {
    if (!presenceMonitor || presenceMonitorStarted) {
      return;
    }
    presenceMonitor.start();
    presenceMonitorStarted = true;
  };
  const installSlackPresenceRuntime = (identity: SlackInstallationIdentity) => {
    if (
      !presenceEventsEnabled ||
      presenceMonitor ||
      identity.kind === "degraded" ||
      opts.abortSignal?.aborted
    ) {
      return;
    }
    presenceRequestAbort = new AbortController();
    const options = resolveSlackLookupClientOptions(
      { ...clientOptions, timeout: SLACK_PRESENCE_REQUEST_TIMEOUT_MS },
      slackDispatcher,
    );
    options.fetch = withSlackPresenceLifecycleSignal(
      options.fetch ?? globalThis.fetch,
      presenceRequestAbort.signal,
    );
    const resolveClient = createSlackWorkspaceClientResolver({
      appClient: new WebClient(token, options),
      token,
      clientOptions: options,
      installationIdentity: identity,
    });
    presenceMonitor = createSlackPresenceMonitor({
      accountId: account.accountId,
      accountConfig: slackCfg.presenceEvents,
      resolveClient: (workspaceTeamId) => resolveClient(workspaceTeamId).users,
      cooldownStore: openSlackPresenceCooldownStore(),
      log: runtime.log,
      error: runtime.error,
    });
    if (runtimeStarted) {
      startPresenceMonitor();
    }
  };
  const handleSlackMessage = createSlackMessageHandler({
    ctx,
    account,
    trackEvent,
    onPrepared: (prepared) => presenceMonitor?.observe(prepared),
  });
  registerSlackCommonEvents({
    ctx,
    handleSlackMessage,
    trackEvent,
  });
  const commandRegistration = await registerSlackMonitorSlashCommands({ ctx, account, trackEvent });
  const appHomeSlashCommandName =
    commandRegistration.mode === "single" ? commandRegistration.name : undefined;

  const resolveSlackWorkspaceConfig = async () => {
    if (!resolveToken || opts.abortSignal?.aborted) {
      return;
    }
    if (channelsConfig && Object.keys(channelsConfig).length > 0) {
      try {
        const entries = Object.keys(channelsConfig).filter((key) => key !== "*");
        if (entries.length > 0) {
          const resolved = await resolveSlackChannelAllowlist({ token: resolveToken, entries });
          const nextChannels = { ...channelsConfig };
          const mapping: string[] = [];
          const unresolved: string[] = [];
          for (const entry of resolved) {
            const source = channelsConfig?.[entry.input];
            if (!source) {
              continue;
            }
            if (!entry.resolved || !entry.id) {
              unresolved.push(entry.input);
              continue;
            }
            const resolvedLabel = formatSlackChannelResolved(entry);
            if (resolvedLabel) {
              mapping.push(resolvedLabel);
            }
            const existing = nextChannels[entry.id] ?? {};
            nextChannels[entry.id] = { ...source, ...existing };
          }
          channelsConfig = nextChannels;
          ctx.channelsConfig = nextChannels;
          summarizeMapping("slack channels", mapping, unresolved, runtime);
        }
      } catch (err) {
        runtime.log?.(
          `slack channel resolve failed; using config entries. ${formatUnknownError(err)}`,
        );
      }
    }

    const allowEntries = normalizeStringEntries(allowFrom).filter((entry) => entry !== "*");
    if (allowEntries.length > 0) {
      const stableResolvedUsers = resolveStableSlackUserAllowlistEntries(allowEntries);
      if (stableResolvedUsers.length > 0) {
        const { mapping, additions } = buildAllowlistResolutionSummary(stableResolvedUsers, {
          formatResolved: formatSlackUserResolved,
        });
        allowFrom = mergeAllowlist({ existing: allowFrom, additions });
        ctx.allowFrom = normalizeAllowList(allowFrom);
        summarizeMapping("slack users", mapping, [], runtime);
      }

      if (allowNameMatching) {
        try {
          const resolvedUsers = await resolveSlackUserAllowlist({
            token: resolveToken,
            entries: allowEntries,
          });
          const { mapping, unresolved, additions } = buildAllowlistResolutionSummary(
            resolvedUsers,
            { formatResolved: formatSlackUserResolved },
          );
          allowFrom = mergeAllowlist({ existing: allowFrom, additions });
          ctx.allowFrom = normalizeAllowList(allowFrom);
          summarizeMapping("slack users", mapping, unresolved, runtime);
        } catch (err) {
          runtime.log?.(
            `slack user resolve failed; using config entries. ${formatUnknownError(err)}`,
          );
        }
      }
    }

    if (channelsConfig && Object.keys(channelsConfig).length > 0) {
      const userEntries = new Set<string>();
      for (const channel of Object.values(channelsConfig)) {
        addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
      }
      if (userEntries.size > 0) {
        const stableResolvedUsers = resolveStableSlackUserAllowlistEntries(Array.from(userEntries));
        if (stableResolvedUsers.length > 0) {
          const { resolvedMap, mapping } = buildAllowlistResolutionSummary(stableResolvedUsers, {
            formatResolved: formatSlackUserResolved,
          });
          const nextChannels = patchAllowlistUsersInConfigEntries({
            entries: channelsConfig,
            resolvedMap,
          });
          channelsConfig = nextChannels;
          ctx.channelsConfig = nextChannels;
          summarizeMapping("slack channel users", mapping, [], runtime);
        }

        if (allowNameMatching) {
          try {
            const resolvedUsers = await resolveSlackUserAllowlist({
              token: resolveToken,
              entries: Array.from(userEntries),
            });
            const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(
              resolvedUsers,
              { formatResolved: formatSlackUserResolved },
            );
            const nextChannels = patchAllowlistUsersInConfigEntries({
              entries: channelsConfig,
              resolvedMap,
            });
            channelsConfig = nextChannels;
            ctx.channelsConfig = nextChannels;
            summarizeMapping("slack channel users", mapping, unresolved, runtime);
          } catch (err) {
            runtime.log?.(
              `slack channel user resolve failed; using config entries. ${formatUnknownError(err)}`,
            );
          }
        }
      }
    }
  };

  let workspaceRuntimePromise: Promise<void> | undefined;
  const installSlackWorkspaceRuntime = async () => {
    if (workspaceRuntimePromise) {
      return await workspaceRuntimePromise;
    }
    workspaceRuntimePromise = (async () => {
      registerSlackWorkspaceEvents({
        ctx,
        appHomeSlashCommandName,
        trackEvent,
      });
      void resolveSlackWorkspaceConfig();
      if (runtimeStarted) {
        startPresenceMonitor();
      }
    })();
    return await workspaceRuntimePromise;
  };

  let approvalRuntimeInstalled = false;
  function installSlackApprovalRuntime(identity: SlackInstallationIdentity) {
    if (
      approvalRuntimeInstalled ||
      identity.kind === "degraded" ||
      !isSlackAnyNativeApprovalClientEnabled({ cfg, accountId: account.accountId })
    ) {
      return;
    }
    const resolveClient = createSlackWorkspaceClientResolver({
      appClient: app.client,
      token,
      clientOptions,
      installationIdentity: identity,
    });
    registerChannelRuntimeContext({
      channelRuntime: opts.channelRuntime,
      channelId: "slack",
      accountId: account.accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      context: {
        app,
        config: slackCfg.execApprovals ?? {},
        resolveClient,
        ...(identity.kind === "enterprise"
          ? {
              enterprise: {
                apiAppId: identity.apiAppId,
                enterpriseId: identity.enterpriseId,
              },
            }
          : {}),
      },
      abortSignal: opts.abortSignal,
    });
    approvalRuntimeInstalled = true;
  }

  async function installSlackRuntimeForIdentity(identity: SlackInstallationIdentity) {
    installSlackApprovalRuntime(identity);
    installSlackPresenceRuntime(identity);
    if (identity.kind === "workspace") {
      await installSlackWorkspaceRuntime();
    }
  }

  let identityRecoveryPromise: Promise<boolean> | undefined;
  async function recoverSlackIdentity() {
    if (ctx.identityHealth.lifecycle !== "blocked") {
      return false;
    }
    if (identityRecoveryPromise) {
      return await identityRecoveryPromise;
    }
    const recovery = (async () => {
      try {
        const auth = await createSlackStartupAuthClient(token, clientOptions).auth.test();
        const recoveredInstallationIdentity = resolveSlackInstallationIdentity({
          auth,
          transportApiAppId: expectedApiAppIdFromAppToken,
        });
        assertSlackInstallationPolicy(recoveredInstallationIdentity);
        const adopted = adoptSlackIdentity({
          ctx,
          identity: account.identity,
          installationIdentity: recoveredInstallationIdentity,
          botUserId: auth.user_id,
          botId: (auth as { bot_id?: string }).bot_id,
        });
        if (!adopted) {
          return false;
        }
        installationState.update(recoveredInstallationIdentity.kind);
        await installSlackRuntimeForIdentity(recoveredInstallationIdentity);
        return true;
      } catch (err) {
        ctx.identityHealth = {
          lifecycle: "blocked",
          lastError: formatUnknownError(err),
        };
        return false;
      }
    })();
    identityRecoveryPromise = recovery;
    try {
      return await recovery;
    } finally {
      if (identityRecoveryPromise === recovery) {
        identityRecoveryPromise = undefined;
      }
    }
  }

  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted && slackMode === "socket") {
      void gracefulStop();
    }
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
  const installationState = registerSlackInstallationState(
    account.accountId,
    installationIdentity.kind,
  );

  try {
    await installSlackRuntimeForIdentity(installationIdentity);
    durableIngress.start();
    runtimeStarted = true;
    startPresenceMonitor();
    if (slackMode === "http" && slackHttpHandler) {
      unregisterHttpHandler = registerSlackHttpHandler({
        path: slackWebhookPath,
        handler: slackHttpHandler,
        log: runtime.log,
        accountId: account.accountId,
      });
      publishSlackConnectedStatus(opts.setStatus, ctx.identityHealth);
    }

    if (slackMode === "socket") {
      let reconnectAttempts = 0;
      let hasLoggedSocketConnected = false;
      while (!opts.abortSignal?.aborted) {
        try {
          const disconnect = await startSlackSocketAndWaitForDisconnect({
            app,
            abortSignal: opts.abortSignal,
            onStarted: async () => {
              reconnectAttempts = 0;
              await recoverSlackIdentity();
              publishSlackConnectedStatus(opts.setStatus, ctx.identityHealth);
              if (!hasLoggedSocketConnected) {
                hasLoggedSocketConnected = true;
                runtime.log?.(
                  ctx.identityHealth.lifecycle === "blocked"
                    ? "slack socket mode connected (degraded identity)"
                    : "slack socket mode connected",
                );
              }
            },
          });
          if (!disconnect) {
            break;
          }
          if (opts.abortSignal?.aborted) {
            break;
          }
          publishSlackDisconnectedStatus(opts.setStatus, disconnect.error);

          // Permanent account and credential failures need operator action.
          if (disconnect.error && isNonRecoverableSlackAuthError(disconnect.error)) {
            publishSlackBlockedStatus(opts.setStatus, disconnect.error);
            runtime.error?.(
              `slack socket mode disconnected due to non-recoverable auth error — skipping channel (${formatUnknownError(disconnect.error)})`,
            );
            throw disconnect.error instanceof Error
              ? disconnect.error
              : new Error(formatUnknownError(disconnect.error));
          }

          reconnectAttempts += 1;
          const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
          runtime.log?.(
            warn(
              formatSlackSocketReconnectMessage({
                event: disconnect.event,
                attempt: reconnectAttempts,
                delayMs,
                error: disconnect.error,
              }),
            ),
          );
          await gracefulStop();
          try {
            await sleepWithAbort(delayMs, opts.abortSignal);
          } catch {
            break;
          }
        } catch (err) {
          if (isNonRecoverableSlackAuthError(err)) {
            publishSlackBlockedStatus(opts.setStatus, err);
            runtime.error?.(
              `slack socket mode failed to start due to non-recoverable auth error — skipping channel (${formatUnknownError(err)})`,
            );
            throw err;
          }
          publishSlackDisconnectedStatus(opts.setStatus, err);
          reconnectAttempts += 1;
          const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
          runtime.error?.(
            formatSlackSocketStartRetryMessage({
              attempt: reconnectAttempts,
              delayMs,
              error: err,
              sdkContext: socketModeLogger.getLastMessage(),
            }),
          );
          try {
            await sleepWithAbort(delayMs, opts.abortSignal);
          } catch {
            break;
          }
          continue;
        }
      }
    } else if (slackMode === "relay" && relayConfig) {
      runtime.log?.(
        `slack relay mode connecting to ${relayConfig.url} gateway_id:${relayConfig.gatewayId}`,
      );
      // Send identity flows through the account default (relay hello ->
      // setIdentity); resolveSlackSendIdentity falls back to it, so claimed
      // relay events replayed after a restart dispatch with correct identity
      // once the relay reattaches.
      durableIngress.attachRelayDispatch(async (message, turnAdoptionLifecycle) => {
        await handleSlackMessage(message as Parameters<typeof handleSlackMessage>[0], {
          source: "message",
          wasMentioned: true,
          awaitDispatch: true,
          turnAdoptionLifecycle,
        });
      });
      await (
        await loadSlackRelaySource()
      ).monitorSlackRelaySource({
        config: relayConfig,
        acceptRelayEvent: durableIngress.acceptRelayEvent,
        runtime,
        abortSignal: opts.abortSignal,
        identityHealth: ctx.identityHealth,
        setStatus: opts.setStatus,
        setIdentity: (identity) => setSlackDefaultSendIdentity(account.accountId, identity),
      });
    } else {
      runtime.log?.(`slack http mode listening at ${slackWebhookPath}`);
      if (!opts.abortSignal?.aborted) {
        await new Promise<void>((resolve) => {
          opts.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
    }
  } finally {
    installationState.release();
    runtimeStarted = false;
    presenceRequestAbort?.abort();
    await presenceMonitor?.stop();
    if (slackMode === "relay") {
      setSlackDefaultSendIdentity(account.accountId, undefined);
    }
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    unregisterSocketModeConnectionDiagnostics();
    unregisterHttpHandler?.();
    await durableIngress.stop();
    await gracefulStop();
    await slackDispatcher?.close();
  }
}

function createSlackWorkspaceClientResolver(params: {
  appClient: WebClient;
  token: string;
  clientOptions: WebClientOptions;
  installationIdentity: SlackInstallationIdentity;
}): (teamId?: string) => WebClient {
  if (params.installationIdentity.kind !== "enterprise") {
    return () => params.appClient;
  }
  const clients = new Map<string, WebClient>();
  return (rawTeamId?: string) => {
    const teamId = rawTeamId;
    if (!teamId || !/^T[A-Z0-9]+$/.test(teamId)) {
      throw new Error("Slack Enterprise Grid workspace client requires a valid teamId");
    }
    const cached = clients.get(teamId);
    if (cached) {
      return cached;
    }
    const client = createSlackWebClient(params.token, {
      ...params.clientOptions,
      teamId,
    });
    clients.set(teamId, client);
    return client;
  };
}

export const resolveSlackRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
