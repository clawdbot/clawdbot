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
import type { SessionScope } from "openclaw/plugin-sdk/config-types";
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
import { normalizeStringEntries } from "openclaw/plugin-sdk/text-runtime";
import { installRequestBodyLimitGuard } from "openclaw/plugin-sdk/webhook-request-guards";
import {
  resolveSlackAccount,
  resolveSlackAccountAllowFrom,
  resolveSlackAccountDmPolicy,
} from "../accounts.js";
import { resolveSlackWebClientOptions } from "../client-options.js";
import { isSlackExecApprovalClientEnabled } from "../exec-approvals.js";
import { normalizeSlackWebhookPath, registerSlackHttpHandler } from "../http/index.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { resolveSlackChannelAllowlist } from "../resolve-channels.js";
import { resolveSlackUserAllowlist } from "../resolve-users.js";
import { resolveSlackAppToken, resolveSlackBotToken } from "../token.js";
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
import { registerSlackMonitorEvents } from "./events.js";
import { createSlackMessageHandler } from "./message-handler.js";
import {
  createSlackBoltApp,
  createSlackSocketDisconnectWaiter,
  formatSlackChannelResolved,
  formatSlackUserResolved,
  gracefulStopSlackApp,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  resolveSlackBoltInterop,
  resolveSlackSocketShutdownClient,
  startSlackSocketAndWaitForDisconnect,
  type SlackBoltResolvedExports,
} from "./provider-support.js";
import {
  formatUnknownError,
  getSocketEmitter,
  isNonRecoverableSlackAuthError,
  SLACK_SOCKET_RECONNECT_POLICY,
  waitForSlackSocketDisconnect,
} from "./reconnect-policy.js";
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

const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

function parseApiAppIdFromAppToken(raw?: string) {
  const token = raw?.trim();
  if (!token) {
    return undefined;
  }
  const match = /^xapp-\d-([a-z0-9]+)-/i.exec(token);
  return match?.[1]?.toUpperCase();
}

export async function monitorSlackProvider(opts: MonitorSlackOpts = {}) {
  const cfg = opts.config ?? getRuntimeConfig();
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  let account = resolveSlackAccount({
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

  const sessionCfg = cfg.session;
  const sessionScope: SessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);

  const slackMode = opts.mode ?? account.config.mode ?? "socket";
  const slackWebhookPath = normalizeSlackWebhookPath(account.config.webhookPath);
  const signingSecret = normalizeResolvedSecretInputString({
    value: account.config.signingSecret,
    path: `channels.slack.accounts.${account.accountId}.signingSecret`,
  });
  const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
  const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
  if (!botToken || (slackMode !== "http" && !appToken)) {
    const missing =
      slackMode === "http"
        ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).`
        : `Slack bot + app tokens missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`;
    throw new Error(missing);
  }
  if (slackMode === "http" && !signingSecret) {
    throw new Error(
      `Slack signing secret missing for account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`,
    );
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
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const reactionMode = slackCfg.reactionNotifications ?? "own";
  const reactionAllowlist = slackCfg.reactionAllowlist ?? [];
  const replyToMode = slackCfg.replyToMode ?? "off";
  const threadHistoryScope = slackCfg.thread?.historyScope ?? "thread";
  const threadInheritParent = slackCfg.thread?.inheritParent ?? false;
  const threadRequireExplicitMention = slackCfg.thread?.requireExplicitMention ?? false;
  const slashCommand = resolveSlackSlashCommandConfig(opts.slashCommand ?? slackCfg.slashCommand);
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId, {
    fallbackLimit: SLACK_TEXT_LIMIT,
  });
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const typingReaction = slackCfg.typingReaction?.trim() ?? "";
  const mediaMaxBytes = (opts.mediaMaxMb ?? slackCfg.mediaMaxMb ?? 20) * 1024 * 1024;
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const clientOptions = resolveSlackWebClientOptions();
  const { app, receiver } = createSlackBoltApp({
    interop: await getSlackBoltInterop(),
    slackMode,
    botToken,
    appToken: appToken ?? undefined,
    signingSecret: signingSecret ?? undefined,
    slackWebhookPath,
    clientOptions: clientOptions as Record<string, unknown>,
    ...(slackCfg.socketMode ? { socketMode: slackCfg.socketMode } : {}),
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

  let botUserId = "";
  let botId = "";
  let teamId = "";
  let apiAppId = "";
  const expectedApiAppIdFromAppToken = parseApiAppIdFromAppToken(appToken);
  try {
    const auth = await app.client.auth.test({ token: botToken });
    botUserId = auth.user_id ?? "";
    botId = (auth as { bot_id?: string }).bot_id ?? "";
    teamId = auth.team_id ?? "";
    apiAppId = (auth as { api_app_id?: string }).api_app_id ?? "";
  } catch {
    // auth test failing is non-fatal; message handler falls back to regex mentions.
  }

  if (apiAppId && expectedApiAppIdFromAppToken && apiAppId !== expectedApiAppIdFromAppToken) {
    runtime.error?.(
      `slack token mismatch: bot token api_app_id=${apiAppId} but app token looks like api_app_id=${expectedApiAppIdFromAppToken}`,
    );
  }

  const ctx = createSlackMonitorContext({
    cfg,
    accountId: account.accountId,
    botToken,
    app,
    runtime,
    botUserId,
    botId,
    teamId,
    apiAppId,
    historyLimit,
    sessionScope,
    mainKey,
    dmEnabled,
    dmPolicy,
    allowFrom,
    allowNameMatching: isDangerousNameMatchingEnabled(slackCfg),
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
    threadRequireExplicitMention,
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

  const handleSlackMessage = createSlackMessageHandler({ ctx, account, trackEvent });
  if (
    isSlackExecApprovalClientEnabled({
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

  registerSlackMonitorEvents({ ctx, account, handleSlackMessage, trackEvent });
  await registerSlackMonitorSlashCommands({ ctx, account, trackEvent });
  if (slackMode === "http" && slackHttpHandler) {
    unregisterHttpHandler = registerSlackHttpHandler({
      path: slackWebhookPath,
      handler: slackHttpHandler,
      log: runtime.log,
      accountId: account.accountId,
    });
  }

  if (resolveToken) {
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
              mapping.push(formatSlackChannelResolved(entry));
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

      if (channelsConfig && Object.keys(channelsConfig).length > 0) {
        const userEntries = new Set<string>();
        for (const channel of Object.values(channelsConfig)) {
          addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
        }

        if (userEntries.size > 0) {
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
      while (!opts.abortSignal?.aborted) {
        try {
          const disconnect = await startSlackSocketAndWaitForDisconnect({
            app,
            abortSignal: opts.abortSignal,
            onStarted: () => {
              reconnectAttempts = 0;
              publishSlackConnectedStatus(opts.setStatus);
              runtime.log?.("slack socket mode connected");
            },
          });
          if (!disconnect) {
            break;
          }
          if (opts.abortSignal?.aborted) {
            break;
          }
          publishSlackDisconnectedStatus(opts.setStatus, disconnect.error);

          // Bail immediately on non-recoverable auth errors during reconnect too.
          if (disconnect.error && isNonRecoverableSlackAuthError(disconnect.error)) {
            runtime.error?.(
              `slack socket mode disconnected due to non-recoverable auth error — skipping channel (${formatUnknownError(disconnect.error)})`,
            );
            throw disconnect.error instanceof Error
              ? disconnect.error
              : new Error(formatUnknownError(disconnect.error));
          }

          reconnectAttempts += 1;
          if (
            SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 &&
            reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts
          ) {
            throw new Error(
              `Slack socket mode reconnect max attempts reached (${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts}) after ${disconnect.event}`,
            );
          }

          const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
          runtime.error?.(
            `slack socket disconnected (${disconnect.event}). retry ${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts || "∞"} in ${Math.round(delayMs / 1000)}s${
              disconnect.error ? ` (${formatUnknownError(disconnect.error)})` : ""
            }`,
          );
          await gracefulStop();
          try {
            await sleepWithAbort(delayMs, opts.abortSignal);
          } catch {
            break;
          }
        } catch (err) {
          // Auth errors (account_inactive, invalid_auth, etc.) are permanent —
          // retrying will never succeed and blocks the entire gateway.  Fail fast.
          if (isNonRecoverableSlackAuthError(err)) {
            runtime.error?.(
              `slack socket mode failed to start due to non-recoverable auth error — skipping channel (${formatUnknownError(err)})`,
            );
            throw err;
          }
          reconnectAttempts += 1;
          if (
            SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 &&
            reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts
          ) {
            throw err;
          }
          const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
          runtime.error?.(
            `slack socket mode failed to start. retry ${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts || "∞"} in ${Math.round(delayMs / 1000)}s (${formatUnknownError(err)})`,
          );
          try {
            await sleepWithAbort(delayMs, opts.abortSignal);
          } catch {
            break;
          }
          continue;
        }
      }
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
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    unregisterHttpHandler?.();
    await gracefulStop();
  }
}

export { isNonRecoverableSlackAuthError } from "./reconnect-policy.js";

export const resolveSlackRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;

export const __testing = {
  formatSlackChannelResolved,
  formatSlackUserResolved,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  resolveSlackSocketShutdownClient,
  gracefulStopSlackApp,
  resolveSlackRuntimeGroupPolicy: resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveSlackBoltInterop,
  createSlackBoltApp,
  createSlackSocketDisconnectWaiter,
  startSlackSocketAndWaitForDisconnect,
  getSocketEmitter,
  waitForSlackSocketDisconnect,
};
