// Slack provider module implements model/runtime integration.
import type { IncomingMessage, ServerResponse } from "node:http";
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
import { warn } from "openclaw/plugin-sdk/runtime-env";
import {
  computeBackoff,
  createNonExitingRuntime,
  sleepWithAbort,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
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
import { resolveSlackWebClientOptions } from "../client-options.js";
import { createSlackStartupAuthClient } from "../client.js";
import { normalizeSlackWebhookPath, registerSlackHttpHandler } from "../http/index.js";
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
import { createSlackMonitorContext } from "./context.js";
import {
  assertEnterpriseSlackDmPolicy,
  assertEnterpriseSlackPolicyConfig,
  assertNoEnterpriseSlackBindings,
  resolveSlackIdentityHealth,
  resolveSlackInstallationIdentity,
  type SlackAuthTestIdentity,
} from "./enterprise-install.js";
import { registerSlackMonitorEvents } from "./events.js";
import { createSlackDurableIngress } from "./ingress.js";
import { createSlackMessageHandler } from "./message-handler.js";
import { openSlackPresenceCooldownStore } from "./presence-cooldown-store.js";
import { createSlackPresenceMonitor, hasSlackPresenceEventsEnabled } from "./presence-monitor.js";
import {
  createSlackBoltApp,
  formatSlackChannelResolved,
  formatSlackUserResolved,
  gracefulStopSlackApp,
  publishSlackConnectedStatus,
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
  const relay =
    params.relay && typeof params.relay === "object" && !Array.isArray(params.relay)
      ? (params.relay as Record<string, unknown>)
      : {};
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
  const enterpriseOrgInstall = account.config.enterpriseOrgInstall === true;
  if (enterpriseOrgInstall && slackMode === "relay") {
    throw new Error(
      `Slack Enterprise Grid org account "${account.accountId}" requires direct socket or HTTP delivery; relay mode is unsupported`,
    );
  }
  if (enterpriseOrgInstall && account.config.execApprovals?.enabled === true) {
    throw new Error(
      `Slack Enterprise Grid org account "${account.accountId}" does not support Slack-native exec approvals`,
    );
  }
  if (enterpriseOrgInstall) {
    assertEnterpriseSlackPolicyConfig({ config: account.config, accountId: account.accountId });
    assertNoEnterpriseSlackBindings({ cfg, accountId: account.accountId });
  }
  const slackWebhookPath = normalizeSlackWebhookPath(account.config.webhookPath);
  const signingSecret = normalizeResolvedSecretInputString({
    value: account.config.signingSecret,
    path: `channels.slack.accounts.${account.accountId}.signingSecret`,
  });
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
  if (enterpriseOrgInstall) {
    assertEnterpriseSlackDmPolicy({
      accountId: account.accountId,
      dmEnabled,
      dmPolicy,
      allowFrom,
    });
  }
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
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
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
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const clientOptions = resolveSlackWebClientOptions();
  const durableIngress = createSlackDurableIngress({
    accountId: account.accountId,
    ...(runtime.log ? { onLog: runtime.log } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
  const { app, receiver, socketModeLogger } = createSlackBoltApp({
    interop: await getSlackBoltInterop(),
    slackMode,
    token,
    appToken: slackMode === "socket" ? (appToken ?? undefined) : undefined,
    signingSecret: slackMode === "http" ? (signingSecret ?? undefined) : undefined,
    slackWebhookPath,
    clientOptions: clientOptions as Record<string, unknown>,
    ...(slackCfg.socketMode ? { socketMode: slackCfg.socketMode } : {}),
    wrapReceiver: durableIngress.wrapReceiver,
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
    botId = normalizeOptionalString((auth as { bot_id?: string }).bot_id) ?? "";
    // User identity has no bot_id; its authenticated human id is both the mention target and
    // the self-send dedupe source. Bot identity keeps the bot_id-gated fail-closed behavior.
    botUserId = account.identity === "user" ? authUserId : botId ? authUserId : "";
    authTestIdentity = auth;
    if (account.identity === "bot") {
      authIdentityWarning = formatSlackBotTokenIdentityWarning({
        auth,
        accountId: account.accountId,
      });
    }
    if (!authUserId && !enterpriseOrgInstall) {
      authTestError = "auth.test returned no user_id";
    }
  } catch (err) {
    authTestError = err instanceof Error ? err.message : String(err);
  }
  const installationIdentity = resolveSlackInstallationIdentity({
    enterpriseOrgInstall,
    auth: authTestError === undefined ? authTestIdentity : undefined,
    authError: authTestError,
    transportApiAppId: expectedApiAppIdFromAppToken,
  });
  const teamId = installationIdentity.kind === "workspace" ? installationIdentity.teamId : "";
  const apiAppId =
    installationIdentity.kind === "degraded" ? "" : (installationIdentity.apiAppId ?? "");
  if (authTestError !== undefined) {
    const identityFailureDetail =
      account.identity === "user"
        ? "explicit self-mention detection will be disabled until restart with a valid user token"
        : "explicit bot-mention detection will be disabled until restart with a valid bot token";
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
    removeAckAfterReply,
  });

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
  const presenceMonitor =
    installationIdentity.kind !== "enterprise" && presenceEventsEnabled
      ? createSlackPresenceMonitor({
          accountId: account.accountId,
          accountConfig: slackCfg.presenceEvents,
          client: app.client.users,
          cooldownStore: openSlackPresenceCooldownStore(),
          log: runtime.log,
          error: runtime.error,
        })
      : undefined;
  if (installationIdentity.kind === "enterprise" && presenceEventsEnabled) {
    runtime.log?.(warn("slack presence events are unavailable for Enterprise Grid org installs"));
  }
  const handleSlackMessage = createSlackMessageHandler({
    ctx,
    account,
    trackEvent,
    onPrepared: presenceMonitor?.observe,
  });
  if (
    installationIdentity.kind !== "enterprise" &&
    isSlackAnyNativeApprovalClientEnabled({
      cfg,
      accountId: account.accountId,
    })
  ) {
    registerChannelRuntimeContext({
      channelRuntime: opts.channelRuntime,
      channelId: "slack",
      accountId: account.accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      context: {
        app,
        config: slackCfg.execApprovals ?? {},
      },
      abortSignal: opts.abortSignal,
    });
  }

  // Resolve command registration first so App Home never advertises an inactive single command.
  const commandRegistration =
    installationIdentity.kind === "enterprise"
      ? ({ mode: "disabled" } as const)
      : await registerSlackMonitorSlashCommands({ ctx, account, trackEvent });
  const appHomeSlashCommandName =
    commandRegistration.mode === "single" ? commandRegistration.name : undefined;
  registerSlackMonitorEvents({
    ctx,
    account,
    handleSlackMessage,
    appHomeSlashCommandName,
    trackEvent,
  });
  durableIngress.start();
  presenceMonitor?.start();
  if (slackMode === "http" && slackHttpHandler) {
    unregisterHttpHandler = registerSlackHttpHandler({
      path: slackWebhookPath,
      handler: slackHttpHandler,
      log: runtime.log,
      accountId: account.accountId,
    });
  }

  if (resolveToken && installationIdentity.kind !== "enterprise") {
    void (async () => {
      if (opts.abortSignal?.aborted) {
        return;
      }

      if (channelsConfig && Object.keys(channelsConfig).length > 0) {
        try {
          const entries = Object.keys(channelsConfig).filter((key) => key !== "*");
          if (entries.length > 0) {
            const resolved = await resolveSlackChannelAllowlist({
              token: resolveToken,
              entries,
            });
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
              {
                formatResolved: formatSlackUserResolved,
              },
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
          const stableResolvedUsers = resolveStableSlackUserAllowlistEntries(
            Array.from(userEntries),
          );
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
                {
                  formatResolved: formatSlackUserResolved,
                },
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
    })();
  }

  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted && slackMode === "socket") {
      void gracefulStop();
    }
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });

  try {
    if (slackMode === "socket") {
      let reconnectAttempts = 0;
      let hasLoggedSocketConnected = false;
      while (!opts.abortSignal?.aborted) {
        try {
          const disconnect = await startSlackSocketAndWaitForDisconnect({
            app,
            abortSignal: opts.abortSignal,
            onStarted: () => {
              reconnectAttempts = 0;
              publishSlackConnectedStatus(opts.setStatus, identityHealth);
              if (!hasLoggedSocketConnected) {
                hasLoggedSocketConnected = true;
                runtime.log?.(
                  identityHealth.healthState === "degraded"
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
            runtime.error?.(
              `slack socket mode failed to start due to non-recoverable auth error — skipping channel (${formatUnknownError(err)})`,
            );
            throw err;
          }
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
    await presenceMonitor?.stop();
    if (slackMode === "relay") {
      setSlackDefaultSendIdentity(account.accountId, undefined);
    }
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    unregisterSocketModeConnectionDiagnostics();
    unregisterHttpHandler?.();
    await durableIngress.stop();
    await gracefulStop();
  }
}

export const resolveSlackRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
