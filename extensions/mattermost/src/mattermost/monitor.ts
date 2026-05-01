import { deliverFinalizableDraftPreview } from "openclaw/plugin-sdk/channel-lifecycle";
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { isReasoningReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount, resolveMattermostReplyToMode } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostMe,
  normalizeMattermostBaseUrl,
  updateMattermostPost,
  type MattermostClient,
  type MattermostPost,
  type MattermostUser,
} from "./client.js";
import { buildMattermostToolStatusText, createMattermostDraftStream } from "./draft-stream.js";
import {
  computeInteractionCallbackUrl,
  createMattermostInteractionHandler,
  resolveInteractionCallbackPath,
  setInteractionCallbackUrl,
  setInteractionSecret,
  type MattermostInteractionResponse,
} from "./interactions.js";
import {
  buildMattermostAllowedModelRefs,
  parseMattermostModelPickerContext,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
} from "./model-picker.js";
import {
  authorizeMattermostCommandInvocation,
  isMattermostSenderAllowed,
  normalizeMattermostAllowEntry,
  normalizeMattermostAllowList,
} from "./monitor-auth.js";
import {
  evaluateMattermostMentionGate,
  mapMattermostChannelTypeToChatType,
  resolveMattermostTrustedChatKind,
} from "./monitor-gating.js";
import {
  formatInboundFromLabel,
  normalizeMention,
  resolveThreadSessionKeys,
} from "./monitor-helpers.js";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";
import { createMattermostMonitorResources, type MattermostMediaInfo } from "./monitor-resources.js";
import { registerMattermostMonitorSlashCommands } from "./monitor-slash.js";
import {
  createMattermostConnectOnce,
  type MattermostEventPayload,
  type MattermostWebSocketFactory,
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import type {
  ChannelAccountSnapshot,
  ChatType,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "./runtime-api.js";
import {
  buildAgentMediaPayload,
  buildModelsProviderData,
  buildPendingHistoryContextFromMap,
  createChannelPairingController,
  createChannelReplyPipeline,
  DEFAULT_GROUP_HISTORY_LIMIT,
  DM_GROUP_ACCESS_REASON,
  isDangerousNameMatchingEnabled,
  logInboundDrop,
  logTypingFailure,
  readStoreAllowFromForDmPolicy,
  recordPendingHistoryEntryIfEnabled,
  registerPluginHttpRoute,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveChannelMediaMaxBytes,
  resolveControlCommandGate,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithLists,
  warnMissingProviderGroupPolicyFallbackOnce,
  type HistoryEntry,
} from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import { cleanupSlashCommands } from "./slash-commands.js";
import { deactivateSlashCommands, getSlashCommandState } from "./slash-state.js";

export {
  evaluateMattermostMentionGate,
  mapMattermostChannelTypeToChatType,
  resolveMattermostTrustedChatKind,
} from "./monitor-gating.js";
export type {
  MattermostMentionGateInput,
  MattermostRequireMentionResolverInput,
} from "./monitor-gating.js";

export type MonitorMattermostOpts = {
  botToken?: string;
  baseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  webSocketFactory?: MattermostWebSocketFactory;
};

type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

type MattermostReaction = {
  user_id?: string;
  post_id?: string;
  emoji_name?: string;
  create_at?: number;
};
const RECENT_MATTERMOST_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MATTERMOST_MESSAGE_MAX = 2000;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeInteractionSourceIps(values?: string[]): string[] {
  return (values ?? [])
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => Boolean(value));
}

const recentInboundMessages = createClaimableDedupe({
  ttlMs: RECENT_MATTERMOST_MESSAGE_TTL_MS,
  memoryMaxSize: RECENT_MATTERMOST_MESSAGE_MAX,
});

export class MattermostRetryableInboundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MattermostRetryableInboundError";
  }
}

export function buildMattermostModelPickerSelectMessageSid(params: {
  postId: string;
  provider: string;
  model: string;
}): string {
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const model = normalizeLowercaseStringOrEmpty(params.model);
  return `interaction:${params.postId}:select:${provider}/${model}`;
}

function buildMattermostInboundReplayKeys(params: {
  accountId: string;
  messageIds: string[];
}): string[] {
  return [...new Set(params.messageIds.map((id) => `${params.accountId}:${id.trim()}`))].filter(
    (key) => !key.endsWith(":"),
  );
}

export async function processMattermostReplayGuardedPost(params: {
  accountId: string;
  messageIds: string[];
  handlePost: () => Promise<void>;
  replayGuard?: ClaimableDedupe;
}): Promise<"processed" | "duplicate"> {
  const replayGuard = params.replayGuard ?? recentInboundMessages;
  const replayKeys = buildMattermostInboundReplayKeys({
    accountId: params.accountId,
    messageIds: params.messageIds,
  });
  if (replayKeys.length === 0) {
    await params.handlePost();
    return "processed";
  }

  const claimedKeys: string[] = [];
  for (const replayKey of replayKeys) {
    const claim = await replayGuard.claim(replayKey);
    if (claim.kind === "claimed") {
      claimedKeys.push(replayKey);
    }
  }
  if (claimedKeys.length === 0) {
    return "duplicate";
  }

  try {
    await params.handlePost();
    await Promise.all(claimedKeys.map((replayKey) => replayGuard.commit(replayKey)));
    return "processed";
  } catch (error) {
    if (error instanceof MattermostRetryableInboundError) {
      claimedKeys.forEach((replayKey) => replayGuard.release(replayKey, { error }));
    } else {
      await Promise.all(claimedKeys.map((replayKey) => replayGuard.commit(replayKey)));
    }
    throw error;
  }
}

function resolveRuntime(opts: MonitorMattermostOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function isSystemPost(post: MattermostPost): boolean {
  return normalizeOptionalString(post.type) !== undefined;
}

function channelChatType(kind: ChatType): "direct" | "group" | "channel" {
  if (kind === "direct") {
    return "direct";
  }
  if (kind === "group") {
    return "group";
  }
  return "channel";
}

export function resolveMattermostReplyRootId(params: {
  kind: ChatType;
  threadRootId?: string;
  replyToId?: string;
}): string | undefined {
  if (params.kind === "direct") {
    return undefined;
  }
  const threadRootId = normalizeOptionalString(params.threadRootId);
  if (threadRootId) {
    return threadRootId;
  }
  return normalizeOptionalString(params.replyToId);
}

export function canFinalizeMattermostPreviewInPlace(params: {
  kind: ChatType;
  previewRootId?: string;
  threadRootId?: string;
  replyToId?: string;
}): boolean {
  return (
    resolveMattermostReplyRootId({
      kind: params.kind,
      threadRootId: params.threadRootId,
      replyToId: params.replyToId,
    }) === params.previewRootId?.trim()
  );
}

export function shouldClearMattermostDraftPreview(params: {
  finalizedViaPreviewPost: boolean;
  finalReplyDelivered: boolean;
}): boolean {
  return params.finalReplyDelivered && !params.finalizedViaPreviewPost;
}

export function shouldFinalizeMattermostPreviewAfterDispatch(params: {
  finalCount: number;
  canFinalizeInPlace: boolean;
}): boolean {
  return params.finalCount === 1 && params.canFinalizeInPlace;
}

type MattermostDraftPreviewState = {
  finalizedViaPreviewPost: boolean;
};

type MattermostDraftPreviewDeliverParams = {
  payload: ReplyPayload;
  info: { kind: "tool" | "block" | "final" };
  kind: ChatType;
  client: MattermostClient;
  draftStream: Pick<
    ReturnType<typeof createMattermostDraftStream>,
    "flush" | "postId" | "clear" | "discardPending" | "seal"
  >;
  effectiveReplyToId?: string;
  resolvePreviewFinalText: (text?: string) => string | undefined;
  previewState: MattermostDraftPreviewState;
  logVerboseMessage: (message: string) => void;
  deliverFinal: () => Promise<void>;
};

export async function deliverMattermostReplyWithDraftPreview(
  params: MattermostDraftPreviewDeliverParams,
): Promise<void> {
  if (isReasoningReplyPayload(params.payload)) {
    return;
  }

  await deliverFinalizableDraftPreview({
    kind: params.info.kind,
    payload: params.payload,
    draft: {
      flush: params.draftStream.flush,
      clear: params.draftStream.clear,
      discardPending: params.draftStream.discardPending,
      seal: params.draftStream.seal,
      id: params.draftStream.postId,
    },
    buildFinalEdit: (payload) => {
      const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
      const previewFinalText = params.resolvePreviewFinalText(payload.text);

      if (
        hasMedia ||
        typeof previewFinalText !== "string" ||
        payload.isError ||
        !canFinalizeMattermostPreviewInPlace({
          kind: params.kind,
          previewRootId: params.effectiveReplyToId,
          threadRootId: params.effectiveReplyToId,
          replyToId: payload.replyToId,
        })
      ) {
        return undefined;
      }
      return { message: previewFinalText };
    },
    editFinal: async (previewPostId, edit) => {
      await updateMattermostPost(params.client, previewPostId, edit);
    },
    deliverNormally: async () => {
      await params.deliverFinal();
    },
    onPreviewFinalized: () => {
      params.previewState.finalizedViaPreviewPost = true;
    },
    logPreviewEditFailure: (err) => {
      params.logVerboseMessage(
        `mattermost preview final edit failed; falling back to normal send (${String(err)})`,
      );
    },
  });
}

export function resolveMattermostEffectiveReplyToId(params: {
  kind: ChatType;
  postId?: string | null;
  replyToMode: "off" | "first" | "all" | "batched";
  threadRootId?: string | null;
}): string | undefined {
  if (params.kind === "direct") {
    return undefined;
  }
  const threadRootId = normalizeOptionalString(params.threadRootId);
  if (threadRootId && params.replyToMode !== "off") {
    return threadRootId;
  }
  const postId = normalizeOptionalString(params.postId);
  if (!postId) {
    return undefined;
  }
  return params.replyToMode === "all" ||
    params.replyToMode === "first" ||
    params.replyToMode === "batched"
    ? postId
    : undefined;
}

export function resolveMattermostThreadSessionContext(params: {
  baseSessionKey: string;
  kind: ChatType;
  postId?: string | null;
  replyToMode: "off" | "first" | "all" | "batched";
  threadRootId?: string | null;
}): { effectiveReplyToId?: string; sessionKey: string; parentSessionKey?: string } {
  const effectiveReplyToId = resolveMattermostEffectiveReplyToId({
    kind: params.kind,
    postId: params.postId,
    replyToMode: params.replyToMode,
    threadRootId: params.threadRootId,
  });
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: params.baseSessionKey,
    threadId: effectiveReplyToId,
    parentSessionKey: effectiveReplyToId ? params.baseSessionKey : undefined,
  });
  return {
    effectiveReplyToId,
    sessionKey: threadKeys.sessionKey,
    parentSessionKey: threadKeys.parentSessionKey,
  };
}

export function resolveMattermostReactionChannelId(
  payload: Pick<MattermostEventPayload, "broadcast" | "data">,
): string | undefined {
  return (
    normalizeOptionalString(payload.broadcast?.channel_id) ??
    normalizeOptionalString(payload.data?.channel_id)
  );
}

function buildMattermostAttachmentPlaceholder(mediaList: MattermostMediaInfo[]): string {
  if (mediaList.length === 0) {
    return "";
  }
  if (mediaList.length === 1) {
    const kind = mediaList[0].kind === "unknown" ? "document" : mediaList[0].kind;
    return `<media:${kind}>`;
  }
  const allImages = mediaList.every((media) => media.kind === "image");
  const label = allImages ? "image" : "file";
  const suffix = mediaList.length === 1 ? label : `${label}s`;
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${mediaList.length} ${suffix})`;
}

function buildMattermostWsUrl(baseUrl: string): string {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Mattermost baseUrl is required");
  }
  const wsBase = normalized.replace(/^http/i, "ws");
  return `${wsBase}/api/v4/websocket`;
}

export async function monitorMattermostProvider(opts: MonitorMattermostOpts = {}): Promise<void> {
  const core = getMattermostRuntime();
  const runtime = resolveRuntime(opts);
  const cfg = (opts.config ?? core.config.current()) as OpenClawConfig;
  const account = resolveMattermostAccount({
    cfg,
    accountId: opts.accountId,
  });
  const pairing = createChannelPairingController({
    core,
    channel: "mattermost",
    accountId: account.accountId,
  });
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
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
  // and API calls return 401 until the account is fully active again.  Retrying
  // here (with exponential backoff) keeps the monitor alive and prevents the
  // framework's auto-restart budget from being exhausted.
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
        opts.statusSink?.({ lastError: String(err), connected: false });
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
  await registerMattermostMonitorSlashCommands({
    client,
    cfg,
    runtime,
    account,
    baseUrl,
    botUserId,
  });
  const slashEnabled = getSlashCommandState(account.accountId) != null;

  // ─── Interactive buttons registration ──────────────────────────────────────
  // Derive a stable HMAC secret from the bot token so CLI and gateway share it.
  setInteractionSecret(account.accountId, botToken);

  // Register HTTP callback endpoint for interactive button clicks.
  // Mattermost POSTs to this URL when a user clicks a button action.
  const interactionPath = resolveInteractionCallbackPath(account.accountId);
  // Recompute from config on each monitor start so reconnects or config reloads can refresh the
  // cached callback URL for downstream callers such as `message action=send`.
  const callbackUrl = computeInteractionCallbackUrl(account.accountId, {
    gateway: cfg.gateway,
    interactions: account.config.interactions,
  });
  setInteractionCallbackUrl(account.accountId, callbackUrl);
  const allowedInteractionSourceIps = normalizeInteractionSourceIps(
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
    // URL parse failed; ignore and continue (we will fail naturally if callbacks cannot be delivered).
  }

  const effectiveInteractionSourceIps =
    allowedInteractionSourceIps.length > 0 ? allowedInteractionSourceIps : ["127.0.0.1", "::1"];

  const unregisterInteractions = registerPluginHttpRoute({
    path: interactionPath,
    fallbackPath: "/mattermost/interactions/default",
    auth: "plugin",
    handler: createMattermostInteractionHandler({
      client,
      botUserId,
      accountId: account.accountId,
      allowedSourceIps: effectiveInteractionSourceIps,
      trustedProxies: cfg.gateway?.trustedProxies,
      allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
      handleInteraction: handleModelPickerInteraction,
      authorizeButtonClick: async ({ payload, post }) => {
        const channelInfo = await resolveChannelInfo(payload.channel_id);
        const isDirect = channelInfo?.type?.trim().toUpperCase() === "D";
        const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
          cfg,
          surface: "mattermost",
        });
        const decision = authorizeMattermostCommandInvocation({
          account,
          cfg,
          senderId: payload.user_id,
          senderName: payload.user_name ?? "",
          channelId: payload.channel_id,
          channelInfo,
          storeAllowFrom: isDirect
            ? await readStoreAllowFromForDmPolicy({
                provider: "mattermost",
                accountId: account.accountId,
                dmPolicy: account.config.dmPolicy ?? "pairing",
                readStore: pairing.readStoreForDmPolicy,
              })
            : undefined,
          allowTextCommands,
          hasControlCommand: false,
        });
        if (decision.ok) {
          return { ok: true };
        }
        return {
          ok: false,
          response: {
            update: {
              message: post.message ?? "",
              props: post.props ?? undefined,
            },
            ephemeral_text: `OpenClaw ignored this action for ${decision.roomLabel}.`,
          },
        };
      },
      resolveSessionKey: async ({ channelId, userId, post }) => {
        const channelInfo = await resolveChannelInfo(channelId);
        const kind = mapMattermostChannelTypeToChatType(channelInfo?.type);
        const teamId = channelInfo?.team_id ?? undefined;
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          teamId,
          peer: {
            kind,
            id: kind === "direct" ? userId : channelId,
          },
        });
        const replyToMode = resolveMattermostReplyToMode(account, kind);
        return resolveMattermostThreadSessionContext({
          baseSessionKey: route.sessionKey,
          kind,
          postId: post.id || undefined,
          replyToMode,
          threadRootId: post.root_id,
        }).sessionKey;
      },
      dispatchButtonClick: async (opts) => {
        const channelInfo = await resolveChannelInfo(opts.channelId);
        const kind = mapMattermostChannelTypeToChatType(channelInfo?.type);
        const chatType = channelChatType(kind);
        const teamId = channelInfo?.team_id ?? undefined;
        const channelName = channelInfo?.name ?? undefined;
        const channelDisplay = channelInfo?.display_name ?? channelName ?? opts.channelId;
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          teamId,
          peer: {
            kind,
            id: kind === "direct" ? opts.userId : opts.channelId,
          },
        });
        const replyToMode = resolveMattermostReplyToMode(account, kind);
        const threadContext = resolveMattermostThreadSessionContext({
          baseSessionKey: route.sessionKey,
          kind,
          postId: opts.post.id || opts.postId,
          replyToMode,
          threadRootId: opts.post.root_id,
        });
        const to = kind === "direct" ? `user:${opts.userId}` : `channel:${opts.channelId}`;
        const bodyText = `[Button click: user @${opts.userName} selected "${opts.actionName}"]`;
        const ctxPayload = core.channel.reply.finalizeInboundContext({
          Body: bodyText,
          BodyForAgent: bodyText,
          RawBody: bodyText,
          CommandBody: bodyText,
          From:
            kind === "direct"
              ? `mattermost:${opts.userId}`
              : kind === "group"
                ? `mattermost:group:${opts.channelId}`
                : `mattermost:channel:${opts.channelId}`,
          To: to,
          SessionKey: threadContext.sessionKey,
          ParentSessionKey: threadContext.parentSessionKey,
          AccountId: route.accountId,
          ChatType: chatType,
          ConversationLabel: `mattermost:${opts.userName}`,
          GroupSubject: kind !== "direct" ? channelDisplay : undefined,
          GroupChannel: channelName ? `#${channelName}` : undefined,
          GroupSpace: teamId,
          SenderName: opts.userName,
          SenderId: opts.userId,
          Provider: "mattermost" as const,
          Surface: "mattermost" as const,
          MessageSid: `interaction:${opts.postId}:${opts.actionId}`,
          ReplyToId: threadContext.effectiveReplyToId,
          MessageThreadId: threadContext.effectiveReplyToId,
          WasMentioned: true,
          CommandAuthorized: false,
          OriginatingChannel: "mattermost" as const,
          OriginatingTo: to,
        });

        const textLimit = core.channel.text.resolveTextChunkLimit(
          cfg,
          "mattermost",
          account.accountId,
          { fallbackLimit: account.textChunkLimit ?? 4000 },
        );
        const tableMode = core.channel.text.resolveMarkdownTableMode({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
        });
        const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
          cfg,
          agentId: route.agentId,
          channel: "mattermost",
          accountId: account.accountId,
          typing: {
            start: () => sendTypingIndicator(opts.channelId, threadContext.effectiveReplyToId),
            onStartError: (err) => {
              logTypingFailure({
                log: (message) => logger.debug?.(message),
                channel: "mattermost",
                target: opts.channelId,
                error: err,
              });
            },
          },
        });
        const { dispatcher, replyOptions, markDispatchIdle } =
          core.channel.reply.createReplyDispatcherWithTyping({
            ...replyPipeline,
            humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            deliver: async (payload: ReplyPayload) => {
              await deliverMattermostReplyPayload({
                core,
                cfg,
                payload,
                to,
                accountId: account.accountId,
                agentId: route.agentId,
                replyToId: resolveMattermostReplyRootId({
                  kind,
                  threadRootId: threadContext.effectiveReplyToId,
                  replyToId: payload.replyToId,
                }),
                textLimit,
                tableMode,
                sendMessage: sendMessageMattermost,
              });
              runtime.log?.(`delivered button-click reply to ${to}`);
            },
            onError: (err, info) => {
              runtime.error?.(`mattermost button-click ${info.kind} reply failed: ${String(err)}`);
            },
            onReplyStart: typingCallbacks?.onReplyStart,
          });

        await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
            onModelSelected,
          },
        });
        markDispatchIdle();
      },
      log: (msg) => runtime.log?.(msg),
    }),
    pluginId: "mattermost",
    source: "mattermost-interactions",
    accountId: account.accountId,
    log: (msg: string) => runtime.log?.(msg),
  });

  const logger = core.logging.getChildLogger({ module: "mattermost" });
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    logger.debug?.(message);
  };
  const mediaMaxBytes =
    resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: () => undefined,
      accountId: account.accountId,
    }) ?? 8 * 1024 * 1024;
  const historyLimit = Math.max(
    0,
    cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const channelHistories = new Map<string, HistoryEntry[]>();
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.mattermost !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "mattermost",
    accountId: account.accountId,
    log: (message) => logVerboseMessage(message),
  });

  const {
    resolveMattermostMedia,
    sendTypingIndicator,
    resolveChannelInfo,
    resolveUserInfo,
    updateModelPickerPost,
  } = createMattermostMonitorResources({
    accountId: account.accountId,
    callbackUrl,
    client,
    logger: {
      debug: (message) => logger.debug?.(String(message)),
    },
    mediaMaxBytes,
    fetchRemoteMedia: (params) => core.channel.media.fetchRemoteMedia(params),
    saveMediaBuffer: (buffer, contentType, direction, maxBytes) =>
      core.channel.media.saveMediaBuffer(Buffer.from(buffer), contentType, direction, maxBytes),
    mediaKindFromMime: (contentType) => core.media.mediaKindFromMime(contentType) as MediaKind,
  });

  const runModelPickerCommand = async (params: {
    commandText: string;
    commandAuthorized: boolean;
    route: ReturnType<typeof core.channel.routing.resolveAgentRoute>;
    sessionKey: string;
    parentSessionKey?: string;
    channelId: string;
    senderId: string;
    senderName: string;
    kind: ChatType;
    chatType: "direct" | "group" | "channel";
    channelName?: string;
    channelDisplay?: string;
    roomLabel: string;
    teamId?: string;
    postId: string;
    messageSid?: string;
    effectiveReplyToId?: string;
    deliverReplies?: boolean;
  }): Promise<string> => {
    const to = params.kind === "direct" ? `user:${params.senderId}` : `channel:${params.channelId}`;
    const fromLabel =
      params.kind === "direct"
        ? `Mattermost DM from ${params.senderName}`
        : `Mattermost message in ${params.roomLabel} from ${params.senderName}`;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: params.commandText,
      BodyForAgent: params.commandText,
      RawBody: params.commandText,
      CommandBody: params.commandText,
      From:
        params.kind === "direct"
          ? `mattermost:${params.senderId}`
          : params.kind === "group"
            ? `mattermost:group:${params.channelId}`
            : `mattermost:channel:${params.channelId}`,
      To: to,
      SessionKey: params.sessionKey,
      ParentSessionKey: params.parentSessionKey,
      AccountId: params.route.accountId,
      ChatType: params.chatType,
      ConversationLabel: fromLabel,
      GroupSubject:
        params.kind !== "direct" ? params.channelDisplay || params.roomLabel : undefined,
      GroupChannel: params.channelName ? `#${params.channelName}` : undefined,
      GroupSpace: params.teamId,
      SenderName: params.senderName,
      SenderId: params.senderId,
      Provider: "mattermost" as const,
      Surface: "mattermost" as const,
      MessageSid: params.messageSid ?? `interaction:${params.postId}:${Date.now()}`,
      ReplyToId: params.effectiveReplyToId,
      MessageThreadId: params.effectiveReplyToId,
      Timestamp: Date.now(),
      WasMentioned: true,
      CommandAuthorized: params.commandAuthorized,
      CommandSource: "native" as const,
      OriginatingChannel: "mattermost" as const,
      OriginatingTo: to,
    });

    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
    });
    const textLimit = core.channel.text.resolveTextChunkLimit(
      cfg,
      "mattermost",
      account.accountId,
      {
        fallbackLimit: account.textChunkLimit ?? 4000,
      },
    );
    const shouldDeliverReplies = params.deliverReplies === true;
    const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
      cfg,
      agentId: params.route.agentId,
      channel: "mattermost",
      accountId: account.accountId,
      typing: shouldDeliverReplies
        ? {
            start: () => sendTypingIndicator(params.channelId, params.effectiveReplyToId),
            onStartError: (err) => {
              logTypingFailure({
                log: (message) => logger.debug?.(message),
                channel: "mattermost",
                target: params.channelId,
                error: err,
              });
            },
          }
        : undefined,
    });
    const capturedTexts: string[] = [];
    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...replyPipeline,
        // Picker-triggered confirmations should stay immediate.
        deliver: async (payload: ReplyPayload) => {
          const trimmedPayload = {
            ...payload,
            text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode).trim(),
          };

          if (!shouldDeliverReplies) {
            if (trimmedPayload.text) {
              capturedTexts.push(trimmedPayload.text);
            }
            return;
          }

          await deliverMattermostReplyPayload({
            core,
            cfg,
            payload: trimmedPayload,
            to,
            accountId: account.accountId,
            agentId: params.route.agentId,
            replyToId: resolveMattermostReplyRootId({
              kind: params.kind,
              threadRootId: params.effectiveReplyToId,
              replyToId: trimmedPayload.replyToId,
            }),
            textLimit,
            // The picker path already converts and trims text before capture/delivery.
            tableMode: "off",
            sendMessage: sendMessageMattermost,
          });
        },
        onError: (err, info) => {
          runtime.error?.(`mattermost model picker ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: typingCallbacks?.onReplyStart,
      });

    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        markDispatchIdle();
      },
      run: () =>
        core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
            onModelSelected,
          },
        }),
    });

    return capturedTexts.join("\n\n").trim();
  };

  async function handleModelPickerInteraction(params: {
    payload: {
      channel_id: string;
      post_id: string;
      team_id?: string;
      user_id: string;
    };
    userName: string;
    context: Record<string, unknown>;
    post: MattermostPost;
  }): Promise<MattermostInteractionResponse | null> {
    const pickerState = parseMattermostModelPickerContext(params.context);
    if (!pickerState) {
      return null;
    }

    if (pickerState.ownerUserId !== params.payload.user_id) {
      return {
        ephemeral_text: "Only the person who opened this picker can use it.",
      };
    }

    const channelInfo = await resolveChannelInfo(params.payload.channel_id);
    const pickerCommandText =
      pickerState.action === "select"
        ? `/model ${pickerState.provider}/${pickerState.model}`
        : pickerState.action === "list"
          ? `/models ${pickerState.provider}`
          : "/models";
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(pickerCommandText, cfg);
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const storeAllowFrom = normalizeMattermostAllowList(
      await readStoreAllowFromForDmPolicy({
        provider: "mattermost",
        accountId: account.accountId,
        dmPolicy,
        readStore: pairing.readStoreForDmPolicy,
      }),
    );
    const auth = authorizeMattermostCommandInvocation({
      account,
      cfg,
      senderId: params.payload.user_id,
      senderName: params.userName,
      channelId: params.payload.channel_id,
      channelInfo,
      storeAllowFrom,
      allowTextCommands,
      hasControlCommand,
    });
    if (!auth.ok) {
      if (auth.denyReason === "dm-pairing") {
        const { code } = await pairing.upsertPairingRequest({
          id: params.payload.user_id,
          meta: { name: params.userName },
        });
        return {
          ephemeral_text: core.channel.pairing.buildPairingReply({
            channel: "mattermost",
            idLine: `Your Mattermost user id: ${params.payload.user_id}`,
            code,
          }),
        };
      }
      const denyText =
        auth.denyReason === "unknown-channel"
          ? "Temporary error: unable to determine channel type. Please try again."
          : auth.denyReason === "dm-disabled"
            ? "This bot is not accepting direct messages."
            : auth.denyReason === "channels-disabled"
              ? "Model picker actions are disabled in channels."
              : auth.denyReason === "channel-no-allowlist"
                ? "Model picker actions are not configured for this channel."
                : "Unauthorized.";
      return {
        ephemeral_text: denyText,
      };
    }
    const kind = auth.kind;
    const chatType = auth.chatType;
    const teamId = auth.channelInfo.team_id ?? params.payload.team_id ?? undefined;
    const channelName = auth.channelName || undefined;
    const channelDisplay = auth.channelDisplay || auth.channelName || params.payload.channel_id;
    const roomLabel = auth.roomLabel;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      teamId,
      peer: {
        kind,
        id: kind === "direct" ? params.payload.user_id : params.payload.channel_id,
      },
    });
    const replyToMode = resolveMattermostReplyToMode(account, kind);
    const threadContext = resolveMattermostThreadSessionContext({
      baseSessionKey: route.sessionKey,
      kind,
      postId: params.post.id || params.payload.post_id,
      replyToMode,
      threadRootId: params.post.root_id,
    });
    const modelSessionRoute = {
      agentId: route.agentId,
      sessionKey: threadContext.sessionKey,
    };

    const data = await buildModelsProviderData(cfg, route.agentId);
    if (data.providers.length === 0) {
      return await updateModelPickerPost({
        channelId: params.payload.channel_id,
        postId: params.payload.post_id,
        message: "No models available.",
      });
    }

    if (pickerState.action === "providers" || pickerState.action === "back") {
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        route: modelSessionRoute,
        data,
      });
      const view = renderMattermostProviderPickerView({
        ownerUserId: pickerState.ownerUserId,
        data,
        currentModel,
      });
      return await updateModelPickerPost({
        channelId: params.payload.channel_id,
        postId: params.payload.post_id,
        message: view.text,
        buttons: view.buttons,
      });
    }

    if (pickerState.action === "list") {
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        route: modelSessionRoute,
        data,
      });
      const view = renderMattermostModelsPickerView({
        ownerUserId: pickerState.ownerUserId,
        data,
        provider: pickerState.provider,
        page: pickerState.page,
        currentModel,
      });
      return await updateModelPickerPost({
        channelId: params.payload.channel_id,
        postId: params.payload.post_id,
        message: view.text,
        buttons: view.buttons,
      });
    }

    const targetModelRef = `${pickerState.provider}/${pickerState.model}`;
    if (!buildMattermostAllowedModelRefs(data).has(targetModelRef)) {
      return {
        ephemeral_text: `That model is no longer available: ${targetModelRef}`,
      };
    }

    void (async () => {
      try {
        await runModelPickerCommand({
          commandText: `/model ${targetModelRef}`,
          commandAuthorized: auth.commandAuthorized,
          route,
          sessionKey: threadContext.sessionKey,
          parentSessionKey: threadContext.parentSessionKey,
          channelId: params.payload.channel_id,
          senderId: params.payload.user_id,
          senderName: params.userName,
          kind,
          chatType,
          channelName,
          channelDisplay,
          roomLabel,
          teamId,
          postId: params.payload.post_id,
          messageSid: buildMattermostModelPickerSelectMessageSid({
            postId: params.payload.post_id,
            provider: pickerState.provider,
            model: pickerState.model,
          }),
          effectiveReplyToId: threadContext.effectiveReplyToId,
          deliverReplies: true,
        });
        const updatedModel = resolveMattermostModelPickerCurrentModel({
          cfg,
          route: modelSessionRoute,
          data,
          skipCache: true,
        });
        const view = renderMattermostModelsPickerView({
          ownerUserId: pickerState.ownerUserId,
          data,
          provider: pickerState.provider,
          page: pickerState.page,
          currentModel: updatedModel,
        });

        await updateModelPickerPost({
          channelId: params.payload.channel_id,
          postId: params.payload.post_id,
          message: view.text,
          buttons: view.buttons,
        });
      } catch (err) {
        runtime.error?.(`mattermost model picker select failed: ${String(err)}`);
      }
    })();

    return {};
  }

  const handlePost = async (
    post: MattermostPost,
    payload: MattermostEventPayload,
    messageIds?: string[],
  ) => {
    const channelId = post.channel_id ?? payload.data?.channel_id ?? payload.broadcast?.channel_id;
    if (!channelId) {
      logVerboseMessage("mattermost: drop post (missing channel id)");
      return;
    }

    const allMessageIds = messageIds?.length ? messageIds : post.id ? [post.id] : [];
    if (allMessageIds.length === 0) {
      logVerboseMessage("mattermost: drop post (missing message id)");
      return;
    }
    const replayResult = await processMattermostReplayGuardedPost({
      accountId: account.accountId,
      messageIds: allMessageIds,
      handlePost: async () => {
        const senderId = post.user_id ?? payload.broadcast?.user_id;
        if (!senderId) {
          logVerboseMessage("mattermost: drop post (missing sender id)");
          return;
        }
        if (senderId === botUserId) {
          logVerboseMessage(`mattermost: drop post (self sender=${senderId})`);
          return;
        }
        if (isSystemPost(post)) {
          logVerboseMessage(`mattermost: drop post (system post type=${post.type ?? "unknown"})`);
          return;
        }

        const channelInfo = await resolveChannelInfo(channelId);
        const kind = resolveMattermostTrustedChatKind({
          channelType: channelInfo?.type,
        });
        const chatType = channelChatType(kind);

        const senderName =
          normalizeOptionalString(payload.data?.sender_name) ??
          normalizeOptionalString((await resolveUserInfo(senderId))?.username) ??
          senderId;
        const rawText = normalizeOptionalString(post.message) ?? "";
        const dmPolicy = account.config.dmPolicy ?? "pairing";
        const normalizedAllowFrom = normalizeMattermostAllowList(account.config.allowFrom ?? []);
        const normalizedGroupAllowFrom = normalizeMattermostAllowList(
          account.config.groupAllowFrom ?? [],
        );
        const storeAllowFrom = normalizeMattermostAllowList(
          await readStoreAllowFromForDmPolicy({
            provider: "mattermost",
            accountId: account.accountId,
            dmPolicy,
            readStore: pairing.readStoreForDmPolicy,
          }),
        );
        const accessDecision = resolveDmGroupAccessWithLists({
          isGroup: kind !== "direct",
          dmPolicy,
          groupPolicy,
          allowFrom: normalizedAllowFrom,
          groupAllowFrom: normalizedGroupAllowFrom,
          storeAllowFrom,
          isSenderAllowed: (allowFrom) =>
            isMattermostSenderAllowed({
              senderId,
              senderName,
              allowFrom,
              allowNameMatching,
            }),
        });
        const effectiveAllowFrom = accessDecision.effectiveAllowFrom;
        const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;
        const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
          cfg,
          surface: "mattermost",
        });
        const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
        const isControlCommand = allowTextCommands && hasControlCommand;
        const useAccessGroups = cfg.commands?.useAccessGroups !== false;
        const commandDmAllowFrom = kind === "direct" ? effectiveAllowFrom : normalizedAllowFrom;
        const senderAllowedForCommands = isMattermostSenderAllowed({
          senderId,
          senderName,
          allowFrom: commandDmAllowFrom,
          allowNameMatching,
        });
        const groupAllowedForCommands = isMattermostSenderAllowed({
          senderId,
          senderName,
          allowFrom: effectiveGroupAllowFrom,
          allowNameMatching,
        });
        const commandGate = resolveControlCommandGate({
          useAccessGroups,
          authorizers: [
            { configured: commandDmAllowFrom.length > 0, allowed: senderAllowedForCommands },
            {
              configured: effectiveGroupAllowFrom.length > 0,
              allowed: groupAllowedForCommands,
            },
          ],
          allowTextCommands,
          hasControlCommand,
        });
        const commandAuthorized = commandGate.commandAuthorized;

        if (accessDecision.decision !== "allow") {
          if (kind === "direct") {
            if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
              logVerboseMessage(`mattermost: drop dm (dmPolicy=disabled sender=${senderId})`);
              return;
            }
            if (accessDecision.decision === "pairing") {
              const { code, created } = await pairing.upsertPairingRequest({
                id: senderId,
                meta: { name: senderName },
              });
              logVerboseMessage(
                `mattermost: pairing request sender=${senderId} created=${created}`,
              );
              if (created) {
                try {
                  await sendMessageMattermost(
                    `user:${senderId}`,
                    core.channel.pairing.buildPairingReply({
                      channel: "mattermost",
                      idLine: `Your Mattermost user id: ${senderId}`,
                      code,
                    }),
                    { cfg, accountId: account.accountId },
                  );
                  opts.statusSink?.({ lastOutboundAt: Date.now() });
                } catch (err) {
                  logVerboseMessage(
                    `mattermost: pairing reply failed for ${senderId}: ${String(err)}`,
                  );
                }
              }
              return;
            }
            logVerboseMessage(`mattermost: drop dm sender=${senderId} (dmPolicy=${dmPolicy})`);
            return;
          }
          if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
            logVerboseMessage("mattermost: drop group message (groupPolicy=disabled)");
            return;
          }
          if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
            logVerboseMessage("mattermost: drop group message (no group allowlist)");
            return;
          }
          if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
            logVerboseMessage(`mattermost: drop group sender=${senderId} (not in groupAllowFrom)`);
            return;
          }
          logVerboseMessage(
            `mattermost: drop group message (groupPolicy=${groupPolicy} reason=${accessDecision.reason})`,
          );
          return;
        }

        if (kind !== "direct" && commandGate.shouldBlock) {
          logInboundDrop({
            log: logVerboseMessage,
            channel: "mattermost",
            reason: "control command (unauthorized)",
            target: senderId,
          });
          return;
        }

        const teamId = payload.data?.team_id ?? channelInfo?.team_id ?? undefined;
        const channelName = payload.data?.channel_name ?? channelInfo?.name ?? "";
        const channelDisplay =
          payload.data?.channel_display_name ?? channelInfo?.display_name ?? channelName;
        const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;

        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          teamId,
          peer: {
            kind,
            id: kind === "direct" ? senderId : channelId,
          },
        });

        const baseSessionKey = route.sessionKey;
        const threadRootId = normalizeOptionalString(post.root_id);
        const replyToMode = resolveMattermostReplyToMode(account, kind);
        const threadContext = resolveMattermostThreadSessionContext({
          baseSessionKey,
          kind,
          postId: post.id,
          replyToMode,
          threadRootId,
        });
        const { effectiveReplyToId, sessionKey, parentSessionKey } = threadContext;
        const historyKey = kind === "direct" ? null : sessionKey;

        const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
        const wasMentioned =
          kind !== "direct" &&
          ((botUsername
            ? normalizeLowercaseStringOrEmpty(rawText).includes(
                `@${normalizeLowercaseStringOrEmpty(botUsername)}`,
              )
            : false) ||
            core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));
        const pendingBody =
          rawText ||
          (post.file_ids?.length
            ? `[Mattermost ${post.file_ids.length === 1 ? "file" : "files"}]`
            : "");
        const pendingSender = senderName;
        const recordPendingHistory = () => {
          const trimmed = pendingBody.trim();
          recordPendingHistoryEntryIfEnabled({
            historyMap: channelHistories,
            limit: historyLimit,
            historyKey: historyKey ?? "",
            entry:
              historyKey && trimmed
                ? {
                    sender: pendingSender,
                    body: trimmed,
                    timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
                    messageId: post.id ?? undefined,
                  }
                : null,
          });
        };

        const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
        const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
        const oncharResult = oncharEnabled
          ? stripOncharPrefix(rawText, oncharPrefixes)
          : { triggered: false, stripped: rawText };
        const oncharTriggered = oncharResult.triggered;
        const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
        const mentionDecision = evaluateMattermostMentionGate({
          kind,
          cfg,
          accountId: account.accountId,
          channelId,
          threadRootId,
          requireMentionOverride: account.requireMention,
          resolveRequireMention: core.channel.groups.resolveRequireMention,
          wasMentioned,
          isControlCommand,
          commandAuthorized,
          oncharEnabled,
          oncharTriggered,
          canDetectMention,
        });
        const { shouldRequireMention, shouldBypassMention } = mentionDecision;

        if (mentionDecision.dropReason === "onchar-not-triggered") {
          logVerboseMessage(
            `mattermost: drop group message (onchar not triggered channel=${channelId} sender=${senderId})`,
          );
          recordPendingHistory();
          return;
        }

        if (mentionDecision.dropReason === "missing-mention") {
          logVerboseMessage(
            `mattermost: drop group message (missing mention channel=${channelId} sender=${senderId} requireMention=${shouldRequireMention} bypass=${shouldBypassMention} canDetectMention=${canDetectMention})`,
          );
          recordPendingHistory();
          return;
        }
        const mediaList = await resolveMattermostMedia(post.file_ids);
        const mediaPlaceholder = buildMattermostAttachmentPlaceholder(mediaList);
        const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
        const baseText = [bodySource, mediaPlaceholder].filter(Boolean).join("\n").trim();
        const bodyText = normalizeMention(baseText, botUsername);
        if (!bodyText) {
          logVerboseMessage(
            `mattermost: drop group message (empty body after normalization channel=${channelId} sender=${senderId})`,
          );
          return;
        }

        core.channel.activity.record({
          channel: "mattermost",
          accountId: account.accountId,
          direction: "inbound",
        });

        const fromLabel = formatInboundFromLabel({
          isGroup: kind !== "direct",
          groupLabel: channelDisplay || roomLabel,
          groupId: channelId,
          groupFallback: roomLabel || "Channel",
          directLabel: senderName,
          directId: senderId,
        });

        const textWithId = `${bodyText}\n[mattermost message id: ${post.id ?? "unknown"} channel: ${channelId}]`;
        const body = core.channel.reply.formatInboundEnvelope({
          channel: "Mattermost",
          from: fromLabel,
          timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
          body: textWithId,
          chatType,
          sender: { name: senderName, id: senderId },
        });
        let combinedBody = body;
        if (historyKey) {
          combinedBody = buildPendingHistoryContextFromMap({
            historyMap: channelHistories,
            historyKey,
            limit: historyLimit,
            currentMessage: combinedBody,
            formatEntry: (entry) =>
              core.channel.reply.formatInboundEnvelope({
                channel: "Mattermost",
                from: fromLabel,
                timestamp: entry.timestamp,
                body: `${entry.body}${
                  entry.messageId ? ` [id:${entry.messageId} channel:${channelId}]` : ""
                }`,
                chatType,
                senderLabel: entry.sender,
              }),
          });
        }

        const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
        const mediaPayload = buildAgentMediaPayload(mediaList);
        const commandBody = rawText.trim();
        const inboundHistory =
          historyKey && historyLimit > 0
            ? (channelHistories.get(historyKey) ?? []).map((entry) => ({
                sender: entry.sender,
                body: entry.body,
                timestamp: entry.timestamp,
              }))
            : undefined;
        const ctxPayload = core.channel.reply.finalizeInboundContext({
          Body: combinedBody,
          BodyForAgent: bodyText,
          InboundHistory: inboundHistory,
          RawBody: bodyText,
          CommandBody: commandBody,
          BodyForCommands: commandBody,
          From:
            kind === "direct"
              ? `mattermost:${senderId}`
              : kind === "group"
                ? `mattermost:group:${channelId}`
                : `mattermost:channel:${channelId}`,
          To: to,
          SessionKey: sessionKey,
          ParentSessionKey: parentSessionKey,
          AccountId: route.accountId,
          ChatType: chatType,
          ConversationLabel: fromLabel,
          GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
          GroupChannel: channelName ? `#${channelName}` : undefined,
          GroupSpace: teamId,
          SenderName: senderName,
          SenderId: senderId,
          Provider: "mattermost" as const,
          Surface: "mattermost" as const,
          MessageSid: post.id ?? undefined,
          MessageSids: allMessageIds.length > 1 ? allMessageIds : undefined,
          MessageSidFirst: allMessageIds.length > 1 ? allMessageIds[0] : undefined,
          MessageSidLast:
            allMessageIds.length > 1 ? allMessageIds[allMessageIds.length - 1] : undefined,
          ReplyToId: effectiveReplyToId,
          MessageThreadId: effectiveReplyToId,
          Timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
          WasMentioned: kind !== "direct" ? mentionDecision.effectiveWasMentioned : undefined,
          CommandAuthorized: commandAuthorized,
          OriginatingChannel: "mattermost" as const,
          OriginatingTo: to,
          ...mediaPayload,
        });
        const pinnedMainDmOwner =
          kind === "direct"
            ? resolvePinnedMainDmOwnerFromAllowlist({
                dmScope: cfg.session?.dmScope,
                allowFrom: account.config.allowFrom,
                normalizeEntry: normalizeMattermostAllowEntry,
              })
            : null;

        const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
          agentId: route.agentId,
        });

        const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
        logVerboseMessage(
          `mattermost inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`,
        );

        const textLimit = core.channel.text.resolveTextChunkLimit(
          cfg,
          "mattermost",
          account.accountId,
          {
            fallbackLimit: account.textChunkLimit ?? 4000,
          },
        );
        const tableMode = core.channel.text.resolveMarkdownTableMode({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
        });

        const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
          cfg,
          agentId: route.agentId,
          channel: "mattermost",
          accountId: account.accountId,
          typing: {
            start: () => sendTypingIndicator(channelId, effectiveReplyToId),
            onStartError: (err) => {
              logTypingFailure({
                log: (message) => logger.debug?.(message),
                channel: "mattermost",
                target: channelId,
                error: err,
              });
            },
          },
        });
        const draftStream = createMattermostDraftStream({
          client,
          channelId,
          rootId: effectiveReplyToId,
          throttleMs: 1200,
          log: logVerboseMessage,
          warn: logVerboseMessage,
        });
        let lastPartialText = "";
        const previewState: MattermostDraftPreviewState = {
          finalizedViaPreviewPost: false,
        };

        const resolvePreviewFinalText = (text?: string) => {
          if (typeof text !== "string") {
            return undefined;
          }
          const formatted = core.channel.text.convertMarkdownTables(text, tableMode);
          const chunkMode = core.channel.text.resolveChunkMode(
            cfg,
            "mattermost",
            account.accountId,
          );
          const chunks = core.channel.text.chunkMarkdownTextWithMode(
            formatted,
            textLimit,
            chunkMode,
          );
          if (!chunks.length && formatted) {
            chunks.push(formatted);
          }
          if (chunks.length != 1) {
            return undefined;
          }
          const trimmed = chunks[0]?.trim();
          if (!trimmed) {
            return undefined;
          }
          if (
            lastPartialText &&
            lastPartialText.startsWith(trimmed) &&
            trimmed.length < lastPartialText.length
          ) {
            return undefined;
          }
          return trimmed;
        };

        const updateDraftFromPartial = (text?: string) => {
          const cleaned = text?.trim();
          if (!cleaned) {
            return;
          }
          if (cleaned === lastPartialText) {
            return;
          }
          if (
            lastPartialText &&
            lastPartialText.startsWith(cleaned) &&
            cleaned.length < lastPartialText.length
          ) {
            return;
          }
          lastPartialText = cleaned;
          draftStream.update(cleaned);
        };

        const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
          core.channel.reply.createReplyDispatcherWithTyping({
            ...replyPipeline,
            humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            typingCallbacks,
            deliver: async (payload: ReplyPayload, info) => {
              await deliverMattermostReplyWithDraftPreview({
                payload,
                info,
                kind,
                client,
                draftStream,
                effectiveReplyToId,
                resolvePreviewFinalText,
                previewState,
                logVerboseMessage,
                deliverFinal: async () => {
                  await deliverMattermostReplyPayload({
                    core,
                    cfg,
                    payload,
                    to,
                    accountId: account.accountId,
                    agentId: route.agentId,
                    replyToId: resolveMattermostReplyRootId({
                      kind,
                      threadRootId: effectiveReplyToId,
                      replyToId: payload.replyToId,
                    }),
                    textLimit,
                    tableMode,
                    sendMessage: sendMessageMattermost,
                  });
                  runtime.log?.(`delivered reply to ${to}`);
                },
              });
            },
            onError: (err, info) => {
              runtime.error?.(`mattermost ${info.kind} reply failed: ${String(err)}`);
            },
          });

        let dispatchSettledBeforeStart = false;
        try {
          await core.channel.turn.run({
            channel: "mattermost",
            accountId: route.accountId,
            raw: post,
            adapter: {
              ingest: () => ({
                id: post.id ?? `${to}:${Date.now()}`,
                timestamp: post.create_at ?? undefined,
                rawText,
                textForAgent: ctxPayload.BodyForAgent,
                textForCommands: ctxPayload.CommandBody,
                raw: post,
              }),
              resolveTurn: () => ({
                channel: "mattermost",
                accountId: route.accountId,
                routeSessionKey: route.sessionKey,
                storePath,
                ctxPayload,
                recordInboundSession: core.channel.session.recordInboundSession,
                record: {
                  updateLastRoute:
                    kind === "direct"
                      ? {
                          sessionKey: route.mainSessionKey,
                          channel: "mattermost",
                          to,
                          accountId: route.accountId,
                          mainDmOwnerPin: pinnedMainDmOwner
                            ? {
                                ownerRecipient: pinnedMainDmOwner,
                                senderRecipient: normalizeMattermostAllowEntry(senderId),
                                onSkip: ({
                                  ownerRecipient,
                                  senderRecipient,
                                }: {
                                  ownerRecipient: string;
                                  senderRecipient: string;
                                }) => {
                                  logVerboseMessage(
                                    `mattermost: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                                  );
                                },
                              }
                            : undefined,
                        }
                      : undefined,
                  onRecordError: (err) => {
                    logVerboseMessage(
                      `mattermost: failed updating session meta id=${post.id ?? "unknown"}: ${String(err)}`,
                    );
                  },
                },
                history: {
                  isGroup: Boolean(historyKey),
                  historyKey: historyKey ?? undefined,
                  historyMap: channelHistories,
                  limit: historyLimit,
                },
                onPreDispatchFailure: async () => {
                  dispatchSettledBeforeStart = true;
                  await core.channel.reply.settleReplyDispatcher({
                    dispatcher,
                    onSettled: () => {
                      markRunComplete();
                      markDispatchIdle();
                    },
                  });
                },
                runDispatch: () =>
                  core.channel.reply.withReplyDispatcher({
                    dispatcher,
                    onSettled: () => {
                      markDispatchIdle();
                    },
                    run: () =>
                      core.channel.reply.dispatchReplyFromConfig({
                        ctx: ctxPayload,
                        cfg,
                        dispatcher,
                        replyOptions: {
                          ...replyOptions,
                          disableBlockStreaming: true,
                          onModelSelected,
                          onPartialReply: (payload) => {
                            updateDraftFromPartial(payload.text);
                          },
                          onAssistantMessageStart: () => {
                            lastPartialText = "";
                          },
                          onReasoningEnd: () => {
                            lastPartialText = "";
                          },
                          onReasoningStream: async () => {
                            if (!lastPartialText) {
                              draftStream.update("Thinking…");
                            }
                          },
                          onToolStart: async (payload) => {
                            draftStream.update(buildMattermostToolStatusText(payload));
                          },
                        },
                      }),
                  }),
              }),
            },
          });
        } finally {
          try {
            await draftStream.stop();
          } catch (err) {
            logVerboseMessage(`mattermost draft preview cleanup failed: ${String(err)}`);
          }
          if (!dispatchSettledBeforeStart) {
            markRunComplete();
          }
        }
      },
    });
    if (replayResult === "duplicate") {
      logVerboseMessage(
        `mattermost: drop post (dedupe account=${account.accountId} ids=${allMessageIds.length})`,
      );
      return;
    }
  };

  const handleReactionEvent = async (payload: MattermostEventPayload) => {
    const reactionData = payload.data?.reaction;
    if (!reactionData) {
      return;
    }
    let reaction: MattermostReaction | null = null;
    if (typeof reactionData === "string") {
      try {
        reaction = JSON.parse(reactionData) as MattermostReaction;
      } catch {
        return;
      }
    } else if (typeof reactionData === "object") {
      reaction = reactionData as MattermostReaction;
    }
    if (!reaction) {
      return;
    }

    const userId = reaction.user_id?.trim();
    const postId = reaction.post_id?.trim();
    const emojiName = reaction.emoji_name?.trim();
    if (!userId || !postId || !emojiName) {
      return;
    }

    // Skip reactions from the bot itself
    if (userId === botUserId) {
      return;
    }

    const isRemoved = payload.event === "reaction_removed";
    const action = isRemoved ? "removed" : "added";

    const senderInfo = await resolveUserInfo(userId);
    const senderName = normalizeOptionalString(senderInfo?.username) ?? userId;

    // Resolve the channel from broadcast or post to route to the correct agent session
    const channelId = resolveMattermostReactionChannelId(payload);
    if (!channelId) {
      // Without a channel id we cannot verify DM/group policies — drop to be safe
      logVerboseMessage(
        `mattermost: drop reaction (no channel_id in broadcast, cannot enforce policy)`,
      );
      return;
    }
    const channelInfo = await resolveChannelInfo(channelId);
    if (!channelInfo?.type) {
      // Cannot determine channel type — drop to avoid policy bypass
      logVerboseMessage(`mattermost: drop reaction (cannot resolve channel type for ${channelId})`);
      return;
    }
    const kind = mapMattermostChannelTypeToChatType(channelInfo.type);

    // Enforce DM/group policy and allowlist checks (same as normal messages)
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const storeAllowFrom = normalizeMattermostAllowList(
      await readStoreAllowFromForDmPolicy({
        provider: "mattermost",
        accountId: account.accountId,
        dmPolicy,
        readStore: pairing.readStoreForDmPolicy,
      }),
    );
    const reactionAccess = resolveDmGroupAccessWithLists({
      isGroup: kind !== "direct",
      dmPolicy,
      groupPolicy,
      allowFrom: normalizeMattermostAllowList(account.config.allowFrom ?? []),
      groupAllowFrom: normalizeMattermostAllowList(account.config.groupAllowFrom ?? []),
      storeAllowFrom,
      isSenderAllowed: (allowFrom) =>
        isMattermostSenderAllowed({
          senderId: userId,
          senderName,
          allowFrom,
          allowNameMatching,
        }),
    });
    if (reactionAccess.decision !== "allow") {
      if (kind === "direct") {
        logVerboseMessage(
          `mattermost: drop reaction (dmPolicy=${dmPolicy} sender=${userId} reason=${reactionAccess.reason})`,
        );
      } else {
        logVerboseMessage(
          `mattermost: drop reaction (groupPolicy=${groupPolicy} sender=${userId} reason=${reactionAccess.reason} channel=${channelId})`,
        );
      }
      return;
    }

    const teamId = channelInfo?.team_id ?? undefined;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      teamId,
      peer: {
        kind,
        id: kind === "direct" ? userId : channelId,
      },
    });
    const sessionKey = route.sessionKey;

    const eventText = `Mattermost reaction ${action}: :${emojiName}: by @${senderName} on post ${postId} in channel ${channelId}`;

    core.system.enqueueSystemEvent(eventText, {
      sessionKey,
      contextKey: `mattermost:reaction:${postId}:${emojiName}:${userId}:${action}`,
    });

    logVerboseMessage(
      `mattermost reaction: ${action} :${emojiName}: by ${senderName} on ${postId}`,
    );
  };

  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "mattermost",
  });
  const debouncer = core.channel.debounce.createInboundDebouncer<{
    post: MattermostPost;
    payload: MattermostEventPayload;
  }>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const channelId =
        entry.post.channel_id ??
        entry.payload.data?.channel_id ??
        entry.payload.broadcast?.channel_id;
      if (!channelId) {
        return null;
      }
      const threadId = normalizeOptionalString(entry.post.root_id);
      const threadKey = threadId ? `thread:${threadId}` : "channel";
      return `mattermost:${account.accountId}:${channelId}:${threadKey}`;
    },
    shouldDebounce: (entry) => {
      if (entry.post.file_ids && entry.post.file_ids.length > 0) {
        return false;
      }
      const text = normalizeOptionalString(entry.post.message) ?? "";
      if (!text) {
        return false;
      }
      return !core.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handlePost(last.post, last.payload);
        return;
      }
      const combinedText = entries
        .map((entry) => normalizeOptionalString(entry.post.message) ?? "")
        .filter(Boolean)
        .join("\n");
      const mergedPost: MattermostPost = {
        ...last.post,
        message: combinedText,
        file_ids: [],
      };
      const ids = entries.map((entry) => entry.post.id).filter(Boolean);
      await handlePost(mergedPost, last.payload, ids.length > 0 ? ids : undefined);
    },
    onError: (err) => {
      runtime.error?.(`mattermost debounce flush failed: ${String(err)}`);
    },
  });

  const wsUrl = buildMattermostWsUrl(baseUrl);
  let seq = 1;
  const connectOnce = createMattermostConnectOnce({
    wsUrl,
    botToken,
    abortSignal: opts.abortSignal,
    statusSink: opts.statusSink,
    runtime,
    webSocketFactory: opts.webSocketFactory,
    nextSeq: () => seq++,
    getBotUpdateAt: async () => {
      const me = await fetchMattermostMe(client);
      return me.update_at ?? 0;
    },
    onPosted: async (post, payload) => {
      await debouncer.enqueue({ post, payload });
    },
    onReaction: async (payload) => {
      await handleReactionEvent(payload);
    },
  });

  let slashShutdownCleanup: Promise<void> | null = null;

  // Clean up slash commands on shutdown
  if (slashEnabled) {
    const runAbortCleanup = () => {
      if (slashShutdownCleanup) {
        return;
      }
      // Snapshot registered commands before deactivating state.
      // This listener may run concurrently with startup in a new process, so we keep
      // monitor shutdown alive until the remote cleanup completes.
      const commands = getSlashCommandState(account.accountId)?.registeredCommands ?? [];
      // Deactivate state immediately to prevent new local dispatches during teardown.
      deactivateSlashCommands(account.accountId);

      slashShutdownCleanup = cleanupSlashCommands({
        client,
        commands,
        log: (msg) => runtime.log?.(msg),
      }).catch((err) => {
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
        opts.statusSink?.({ lastError: String(err), connected: false });
      },
      onReconnect: (delayMs) => {
        runtime.log?.(`mattermost reconnecting in ${Math.round(delayMs / 1000)}s`);
      },
    });
  } finally {
    unregisterInteractions?.();
  }

  const slashShutdownCleanupPromise = slashShutdownCleanup;
  if (slashShutdownCleanupPromise) {
    await Promise.resolve(slashShutdownCleanupPromise);
  }
}
