// Mattermost plugin module orchestrates monitor setup, ingress, and teardown.
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { isLoopbackHost } from "openclaw/plugin-sdk/gateway-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostMe,
  normalizeMattermostBaseUrl,
  type MattermostUser,
} from "./client.js";
import {
  computeInteractionCallbackUrl,
  resolveInteractionCallbackPath,
  setInteractionCallbackUrl,
  setInteractionSecret,
} from "./interactions.js";
import { normalizeMention } from "./monitor-helpers.js";
import {
  createMattermostIngressMonitor,
  type MattermostIngressLifecycle,
  type MattermostIngressPost,
} from "./monitor-ingress.js";
import { registerMattermostInteractions } from "./monitor-interactions.js";
import { createMattermostModelPickerInteractionHandler } from "./monitor-model-picker.js";
import { createMattermostPostHandler } from "./monitor-posts.js";
import { createMattermostReactionHandler } from "./monitor-reactions.js";
import { createMattermostMonitorResources } from "./monitor-resources.js";
import { registerMattermostMonitorSlashCommands } from "./monitor-slash.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import {
  createMattermostConnectOnce,
  type MattermostEventPayload,
  type MattermostWebSocketFactory,
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";
import type { ChannelAccountSnapshot, OpenClawConfig, RuntimeEnv } from "./runtime-api.js";
import {
  createChannelPairingController,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveChannelMediaMaxBytes,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./runtime-api.js";
import { cleanupSlashCommands } from "./slash-commands.js";
import { deactivateSlashCommands, getSlashCommandState } from "./slash-state.js";

type MonitorMattermostOpts = {
  botToken?: string;
  baseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  webSocketFactory?: MattermostWebSocketFactory;
};

function publishMattermostRecoveringStatus(
  statusSink: MonitorMattermostOpts["statusSink"],
  error: unknown,
): void {
  statusSink?.({
    lastError: String(error),
    connected: false,
    lifecycle: "recovering",
  });
}

export async function monitorMattermostProvider(opts: MonitorMattermostOpts = {}): Promise<void> {
  const core = getMattermostRuntime();
  const runtime =
    opts.runtime ??
    ({
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    } satisfies RuntimeEnv);
  const cfg = (opts.config ?? core.config.current()) as OpenClawConfig;
  const account = resolveMattermostAccount({ cfg, accountId: opts.accountId });
  const pairing = createChannelPairingController({
    core,
    channel: "mattermost",
    accountId: account.accountId,
  });
  const botToken =
    normalizeOptionalString(opts.botToken) ?? normalizeOptionalString(account.botToken);
  if (!botToken) {
    throw new Error(
      `Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`,
    );
  }
  const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`,
    );
  }
  const client = createMattermostClient({
    baseUrl,
    botToken,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
  });

  // Wait for the Mattermost API to accept our bot token before proceeding.
  // When a bot account is disabled and re-enabled, the session is invalidated
  // and API calls return 401 until the account is fully active again. Retrying
  // here keeps the monitor alive instead of exhausting the auto-restart budget.
  let botUser!: MattermostUser;
  await runWithReconnect(
    async () => {
      botUser = await fetchMattermostMe(client);
    },
    {
      abortSignal: opts.abortSignal,
      jitterRatio: 0.2,
      shouldReconnect: ({ outcome }) => outcome === "rejected",
      onError: (err) => {
        runtime.error?.(`mattermost: API auth failed: ${String(err)}`);
        publishMattermostRecoveringStatus(opts.statusSink, err);
      },
      onReconnect: (delayMs) => {
        runtime.log?.(`mattermost: API not accessible, retrying in ${Math.round(delayMs / 1000)}s`);
      },
    },
  );
  if (opts.abortSignal?.aborted) {
    return;
  }
  const botUserId = botUser.id;
  const botUsername = normalizeOptionalString(botUser.username);
  runtime.log?.(`mattermost connected as ${botUsername ? `@${botUsername}` : botUserId}`);

  // Derive a stable HMAC secret so CLI and gateway validate the same callbacks.
  setInteractionSecret(account.accountId, botToken);
  const interactionPath = resolveInteractionCallbackPath(account.accountId);
  // Refresh the cached URL on every monitor start for reconnects and config reloads.
  const callbackUrl = computeInteractionCallbackUrl(account.accountId, {
    gateway: cfg.gateway,
    interactions: account.config.interactions,
  });
  setInteractionCallbackUrl(account.accountId, callbackUrl);
  const allowedInteractionSourceIps = normalizeTrimmedStringList(
    account.config.interactions?.allowedSourceIps,
  );
  try {
    const mmHost = new URL(baseUrl).hostname;
    const callbackHost = new URL(callbackUrl).hostname;
    if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) {
      runtime.error?.(
        `mattermost: interactions callbackUrl resolved to ${callbackUrl} (loopback) while baseUrl is ${baseUrl}. This MAY be unreachable depending on your deployment. If button clicks don't work, set channels.mattermost.interactions.callbackBaseUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`,
      );
    }
    if (!isLoopbackHost(callbackHost) && allowedInteractionSourceIps.length === 0) {
      runtime.error?.(
        `mattermost: interactions callbackUrl resolved to ${callbackUrl} without channels.mattermost.interactions.allowedSourceIps. For safety, non-loopback callback sources will be rejected until you allowlist the Mattermost server or trusted ingress IPs.`,
      );
    }
  } catch {
    // Invalid callback URLs fail naturally if Mattermost tries to deliver to them.
  }

  const logger = core.logging.getChildLogger({ module: "mattermost" });
  const logVerboseMessage = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      logger.debug?.(message);
    }
  };
  const mediaMaxBytes =
    resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: () => account.config.mediaMaxMb,
      accountId: account.accountId,
    }) ?? 8 * 1024 * 1024;
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.mattermost !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "mattermost",
    accountId: account.accountId,
    log: logVerboseMessage,
  });
  const resources = createMattermostMonitorResources({
    accountId: account.accountId,
    callbackUrl,
    client,
    logger: { debug: (message) => logger.debug?.(String(message)) },
    mediaMaxBytes,
    saveRemoteMedia: (params) => core.channel.media.saveRemoteMedia(params),
    mediaKindFromMime: (contentType) => core.media.mediaKindFromMime(contentType),
  });
  const monitor: MattermostMonitorContext = {
    core,
    runtime,
    cfg,
    account,
    client,
    pairing,
    botUserId,
    botUsername,
    groupPolicy,
    resources,
    logDebugMessage: (message) => logger.debug?.(message),
    logVerboseMessage,
    statusSink: opts.statusSink,
  };
  const unregisterInteractions = registerMattermostInteractions({
    monitor,
    interactionPath,
    allowedSourceIps:
      allowedInteractionSourceIps.length > 0 ? allowedInteractionSourceIps : ["127.0.0.1", "::1"],
    handleModelPickerInteraction: createMattermostModelPickerInteractionHandler(monitor),
  });
  try {
    await registerMattermostMonitorSlashCommands({
      client,
      cfg,
      runtime,
      account,
      baseUrl,
      botUserId,
    });
  } catch (error) {
    // The callback route must exist before remote slash setup, but not outlive failed startup.
    unregisterInteractions();
    throw error;
  }
  const slashEnabled = getSlashCommandState(account.accountId) != null;
  const handlePost = createMattermostPostHandler(monitor);
  const handleReactionEvent = createMattermostReactionHandler(monitor);

  const debouncer = core.channel.debounce.createInboundDebouncer<{
    post: MattermostIngressPost;
    payload: MattermostEventPayload;
    turnAdoptionLifecycle: MattermostIngressLifecycle;
  }>({
    debounceMs: core.channel.debounce.resolveInboundDebounceMs({
      cfg,
      channel: "mattermost",
    }),
    buildKey: (entry) => {
      const channelId =
        entry.post.channel_id ??
        entry.payload.data?.channel_id ??
        entry.payload.broadcast?.channel_id;
      if (!channelId || !entry.post.user_id) {
        return null;
      }
      const threadId = normalizeOptionalString(entry.post.root_id);
      // Cross-sender merging would apply only the final post's identity during access checks.
      return `mattermost:${account.accountId}:${channelId}:${threadId ? `thread:${threadId}` : "channel"}:${entry.post.user_id}`;
    },
    shouldDebounce: (entry) => {
      // Typed posts are dropped downstream; batching would let their text or type affect a user post.
      if (normalizeOptionalString(entry.post.type) !== undefined || entry.post.file_ids?.length) {
        return false;
      }
      const text = normalizeOptionalString(entry.post.message) ?? "";
      // Same mention-stripped view as the post handler, so "@bot /new" is never batched.
      return (
        Boolean(text) &&
        !core.channel.commands.isControlCommandMessage(normalizeMention(text, botUsername), cfg)
      );
    },
    onFlush: (entries, createFlush) => {
      const last = entries.at(-1);
      const { lifecycle, settle } = fanInChannelIngressLifecycles(
        entries.map((entry) => entry.turnAdoptionLifecycle),
      );
      return createFlush({
        lifecycle,
        dispatch: async (admissionLifecycle) => {
          if (!last) {
            return;
          }
          try {
            if (entries.length === 1) {
              await handlePost(last.post, last.payload, admissionLifecycle);
              await settle();
              return;
            }
            const mergedPost: MattermostIngressPost = {
              ...last.post,
              message: entries
                .map((entry) => normalizeOptionalString(entry.post.message) ?? "")
                .filter(Boolean)
                .join("\n"),
              file_ids: [],
            };
            await handlePost(
              mergedPost,
              last.payload,
              admissionLifecycle,
              entries.map((entry) => entry.post.id),
            );
            await settle();
          } catch (error) {
            await admissionLifecycle.onAbandoned();
            throw error;
          }
        },
      });
    },
    onError: (err) => {
      runtime.error?.(`mattermost debounce flush failed: ${String(err)}`);
    },
  });
  const ingress = createMattermostIngressMonitor({
    accountId: account.accountId,
    runtime,
    abortSignal: opts.abortSignal,
    dispatch: async (post, payload, turnAdoptionLifecycle) => {
      // Deferred claims settle through lifecycle callbacks, so terminal flush
      // errors spend the drain's bounded retry budget before dead-lettering.
      await debouncer.enqueue({ post, payload, turnAdoptionLifecycle });
      return { kind: "deferred" };
    },
  });
  let sequence = 1;
  const connectOnce = createMattermostConnectOnce({
    wsUrl: `${baseUrl.replace(/^http/i, "ws")}/api/v4/websocket`,
    botToken,
    abortSignal: opts.abortSignal,
    statusSink: opts.statusSink,
    runtime,
    webSocketFactory: opts.webSocketFactory,
    nextSeq: () => sequence++,
    getBotUpdateAt: async () => (await fetchMattermostMe(client)).update_at ?? 0,
    onPosted: ingress.receive,
    onReaction: handleReactionEvent,
  });

  let slashShutdownCleanup: Promise<void> | null = null;
  if (slashEnabled) {
    const runAbortCleanup = () => {
      if (slashShutdownCleanup) {
        return;
      }
      // Snapshot registered commands before deactivation and keep monitor shutdown
      // alive until the remote cleanup completes.
      const commands = getSlashCommandState(account.accountId)?.registeredCommands ?? [];
      deactivateSlashCommands(account.accountId);
      slashShutdownCleanup = cleanupSlashCommands({
        client,
        commands,
        log: (message) => runtime.log?.(message),
      }).catch((err: unknown) => {
        runtime.error?.(`mattermost: slash cleanup failed: ${String(err)}`);
      });
    };
    if (opts.abortSignal?.aborted) {
      runAbortCleanup();
    } else {
      opts.abortSignal?.addEventListener("abort", runAbortCleanup, { once: true });
    }
  }

  try {
    await runWithReconnect(connectOnce, {
      abortSignal: opts.abortSignal,
      jitterRatio: 0.2,
      onError: (err) => {
        runtime.error?.(`mattermost connection failed: ${String(err)}`);
        publishMattermostRecoveringStatus(opts.statusSink, err);
      },
      onReconnect: (delayMs) => {
        runtime.log?.(`mattermost reconnecting in ${Math.round(delayMs / 1000)}s`);
      },
    });
  } finally {
    await ingress.stop();
    unregisterInteractions();
  }
  const slashShutdownCleanupPromise = slashShutdownCleanup;
  if (slashShutdownCleanupPromise) {
    await Promise.resolve(slashShutdownCleanupPromise);
  }
}
