import type { IncomingMessage, ServerResponse } from "node:http";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { ResolvedZaloAccount } from "./accounts.js";
import {
  ZaloApiError,
  deleteWebhook,
  getWebhookInfo,
  getUpdates,
  sendChatAction,
  sendMessage,
  sendPhoto,
  setWebhook,
  type ZaloFetch,
  type ZaloMessage,
  type ZaloUpdate,
} from "./api.js";
import {
  evaluateZaloGroupAccess,
  isZaloSenderAllowed,
  resolveZaloRuntimeGroupPolicy,
} from "./group-access.js";
import { resolveZaloProxyFetch } from "./proxy.js";
import {
  createChannelPairingController,
  createChannelReplyPipeline,
  deliverTextOrMediaReply,
  logTypingFailure,
  registerPluginHttpRoute,
  resolveWebhookPath,
  resolveDefaultGroupPolicy,
  resolveDirectDmAuthorizationOutcome,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
  resolveSenderCommandAuthorizationWithRuntime,
  waitForAbortSignal,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./runtime-api.js";
import { getZaloRuntime } from "./runtime.js";
export type { ZaloRuntimeEnv } from "./monitor.types.js";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import {
  prepareHostedZaloMediaUrl,
  resolveHostedZaloMediaRoutePrefix,
  tryHandleHostedZaloMediaRequest,
} from "./outbound-media.js";

export type ZaloMonitorOptions = {
  token: string;
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  abortSignal: AbortSignal;
  useWebhook?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  fetcher?: ZaloFetch;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const ZALO_TEXT_LIMIT = 2000;
const DEFAULT_MEDIA_MAX_MB = 5;
const WEBHOOK_CLEANUP_TIMEOUT_MS = 5_000;
const ZALO_TYPING_TIMEOUT_MS = 5_000;

type ZaloCoreRuntime = ReturnType<typeof getZaloRuntime>;
type ZaloStatusSink = (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
type ZaloWebhookModule = typeof import("./monitor.webhook.js");
type ZaloProcessingContext = {
  token: string;
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  mediaMaxMb: number;
  canHostMedia: boolean;
  webhookUrl?: string;
  webhookPath?: string;
  statusSink?: ZaloStatusSink;
  fetcher?: ZaloFetch;
};
type ZaloPollingLoopParams = ZaloProcessingContext & {
  abortSignal: AbortSignal;
  isStopped: () => boolean;
};
type ZaloUpdateProcessingParams = ZaloProcessingContext & {
  update: ZaloUpdate;
};

let zaloWebhookModulePromise: Promise<ZaloWebhookModule> | undefined;
const hostedMediaRouteRefs = new Map<string, { count: number; unregisters: Array<() => void> }>();

function loadZaloWebhookModule(): Promise<ZaloWebhookModule> {
  zaloWebhookModulePromise ??= import("./monitor.webhook.js");
  return zaloWebhookModulePromise;
}

function registerSharedHostedMediaRoute(params: {
  path: string;
  accountId: string;
  log?: (message: string) => void;
}): () => void {
  const unregister = registerPluginHttpRoute({
    auth: "plugin",
    match: "prefix",
    path: params.path,
    replaceExisting: true,
    pluginId: "zalo",
    source: "zalo-hosted-media",
    accountId: params.accountId,
    log: params.log,
    handler: async (req, res) => {
      const handled = await tryHandleHostedZaloMediaRequest(req, res);
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not Found");
      }
    },
  });

  const existing = hostedMediaRouteRefs.get(params.path);
  if (existing) {
    existing.count += 1;
    existing.unregisters.push(unregister);
    return () => {
      const current = hostedMediaRouteRefs.get(params.path);
      if (!current) {
        return;
      }
      if (current.count > 1) {
        current.count -= 1;
        return;
      }
      hostedMediaRouteRefs.delete(params.path);
      for (const unregisterHandle of current.unregisters) {
        unregisterHandle();
      }
    };
  }

  hostedMediaRouteRefs.set(params.path, { count: 1, unregisters: [unregister] });
  return () => {
    const current = hostedMediaRouteRefs.get(params.path);
    if (!current) {
      return;
    }
    if (current.count > 1) {
      current.count -= 1;
      return;
    }
    hostedMediaRouteRefs.delete(params.path);
    for (const unregisterHandle of current.unregisters) {
      unregisterHandle();
    }
  };
}

type ZaloMessagePipelineParams = ZaloProcessingContext & {
  message: ZaloMessage;
  text?: string;
  mediaPath?: string;
  mediaType?: string;
  authorization?: ZaloMessageAuthorizationResult;
};
type ZaloImageMessageParams = ZaloProcessingContext & {
  message: ZaloMessage;
};
type ZaloMessageAuthorizationResult = {
  chatId: string;
  commandAuthorized: boolean | undefined;
  isGroup: boolean;
  rawBody: string;
  senderId: string;
  senderName: string | undefined;
};

function formatZaloError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

function describeWebhookTarget(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl;
  }
}

function normalizeWebhookUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

function logVerbose(core: ZaloCoreRuntime, runtime: ZaloRuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[zalo] ${message}`);
  }
}

export async function handleZaloWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const { handleZaloWebhookRequest: handleZaloWebhookRequestInternal } =
    await loadZaloWebhookModule();
  return await handleZaloWebhookRequestInternal(req, res, async ({ update, target }) => {
    await processUpdate({
      update,
      token: target.token,
      account: target.account,
      config: target.config,
      runtime: target.runtime,
      core: target.core as ZaloCoreRuntime,
      mediaMaxMb: target.mediaMaxMb,
      canHostMedia: target.canHostMedia,
      webhookUrl: target.webhookUrl,
      webhookPath: target.webhookPath,
      statusSink: target.statusSink,
      fetcher: target.fetcher,
    });
  });
}

function startPollingLoop(params: ZaloPollingLoopParams) {
  const {
    token,
    account,
    config,
    runtime,
    core,
    mediaMaxMb,
    canHostMedia,
    webhookUrl,
    webhookPath,
    abortSignal,
    isStopped,
    statusSink,
    fetcher,
  } = params;
  const pollTimeout = 30;
  const processingContext = {
    token,
    account,
    config,
    runtime,
    core,
    mediaMaxMb,
    canHostMedia,
    webhookUrl,
    webhookPath,
    statusSink,
    fetcher,
  };

  runtime.log?.(`[${account.accountId}] Zalo polling loop started timeout=${String(pollTimeout)}s`);

  const poll = async (): Promise<void> => {
    if (isStopped() || abortSignal.aborted) {
      return undefined;
    }

    try {
      const response = await getUpdates(token, { timeout: pollTimeout }, fetcher);
      if (isStopped() || abortSignal.aborted) {
        return undefined;
      }
      if (response.ok && response.result) {
        statusSink?.({ lastInboundAt: Date.now() });
        await processUpdate({
          update: response.result,
          ...processingContext,
        });
      }
    } catch (err) {
      if (err instanceof ZaloApiError && err.isPollingTimeout) {
        // no updates
      } else if (!isStopped() && !abortSignal.aborted) {
        runtime.error?.(`[${account.accountId}] Zalo polling error: ${formatZaloError(err)}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    if (!isStopped() && !abortSignal.aborted) {
      setImmediate(poll);
    }
  };

  void poll();
}

async function processUpdate(params: ZaloUpdateProcessingParams): Promise<void> {
  const { update, token, account, config, runtime, core, mediaMaxMb, statusSink, fetcher } = params;
  const { event_name, message } = update;
  const sharedContext = {
    token,
    account,
    config,
    runtime,
    core,
    mediaMaxMb,
    canHostMedia: params.canHostMedia,
    webhookUrl: params.webhookUrl,
    webhookPath: params.webhookPath,
    statusSink,
    fetcher,
  };
  if (!message) {
    return undefined;
  }

  switch (event_name) {
    case "message.text.received":
      await handleTextMessage({
        message,
        ...sharedContext,
      });
      break;
    case "message.image.received":
      await handleImageMessage({
        message,
        ...sharedContext,
        mediaMaxMb,
      });
      break;
    case "message.sticker.received":
      logVerbose(core, runtime, `[${account.accountId}] Received sticker from ${message.from.id}`);
      break;
    case "message.unsupported.received":
      logVerbose(
        core,
        runtime,
        `[${account.accountId}] Received unsupported message type from ${message.from.id}`,
      );
      break;
  }
}

async function handleTextMessage(
  params: ZaloProcessingContext & { message: ZaloMessage },
): Promise<void> {
  const { message } = params;
  const { text } = message;
  if (!text?.trim()) {
    return undefined;
  }

  await processMessageWithPipeline({
    ...params,
    text,
    mediaPath: undefined,
    mediaType: undefined,
  });
}

async function handleImageMessage(params: ZaloImageMessageParams): Promise<void> {
  const { message, mediaMaxMb, account, core, runtime } = params;
  const { photo_url, caption } = message;
  const authorization = await authorizeZaloMessage({
    ...params,
    text: caption,
    // Use a sentinel so auth sees this as an inbound image before the download happens.
    mediaPath: photo_url ? "__pending_media__" : undefined,
    mediaType: undefined,
  });
  if (!authorization) {
    return;
  }

  let mediaPath: string | undefined;
  let mediaType: string | undefined;

  if (photo_url) {
    try {
      const maxBytes = mediaMaxMb * 1024 * 1024;
      const fetched = await core.channel.media.fetchRemoteMedia({ url: photo_url, maxBytes });
      const saved = await core.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
    } catch (err) {
      runtime.error?.(`[${account.accountId}] Failed to download Zalo image: ${String(err)}`);
    }
  }

  await processMessageWithPipeline({
    ...params,
    authorization,
    text: caption,
    mediaPath,
    mediaType,
  });
}

async function authorizeZaloMessage(
  params: ZaloMessagePipelineParams,
): Promise<ZaloMessageAuthorizationResult | undefined> {
  const { message, account, config, runtime, core, text, mediaPath, token, statusSink, fetcher } =
    params;
  const pairing = createChannelPairingController({
    core,
    channel: "zalo",
    accountId: account.accountId,
  });
  const { from, chat } = message;

  const isGroup = chat.chat_type === "GROUP";
  const chatId = chat.id;
  const senderId = from.id;
  const senderName = from.display_name ?? from.name;

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const configuredGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((v) => String(v));
  const groupAllowFrom =
    configuredGroupAllowFrom.length > 0 ? configuredGroupAllowFrom : configAllowFrom;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const groupAccess = isGroup
    ? evaluateZaloGroupAccess({
        providerConfigPresent: config.channels?.zalo !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
        groupAllowFrom,
        senderId,
      })
    : undefined;
  if (groupAccess) {
    warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied: groupAccess.providerMissingFallbackApplied,
      providerKey: "zalo",
      accountId: account.accountId,
      log: (message) => logVerbose(core, runtime, message),
    });
    if (!groupAccess.allowed) {
      if (groupAccess.reason === "disabled") {
        logVerbose(core, runtime, `zalo: drop group ${chatId} (groupPolicy=disabled)`);
      } else if (groupAccess.reason === "empty_allowlist") {
        logVerbose(
          core,
          runtime,
          `zalo: drop group ${chatId} (groupPolicy=allowlist, no groupAllowFrom)`,
        );
      } else if (groupAccess.reason === "sender_not_allowlisted") {
        logVerbose(core, runtime, `zalo: drop group sender ${senderId} (groupPolicy=allowlist)`);
      }
      return undefined;
    }
  }

  const rawBody = text?.trim() || (mediaPath ? "<media:image>" : "");
  const { senderAllowedForCommands, commandAuthorized } =
    await resolveSenderCommandAuthorizationWithRuntime({
      cfg: config,
      rawBody,
      isGroup,
      dmPolicy,
      configuredAllowFrom: configAllowFrom,
      configuredGroupAllowFrom: groupAllowFrom,
      senderId,
      isSenderAllowed: isZaloSenderAllowed,
      readAllowFromStore: pairing.readAllowFromStore,
      runtime: core.channel.commands,
    });

  const directDmOutcome = resolveDirectDmAuthorizationOutcome({
    isGroup,
    dmPolicy,
    senderAllowedForCommands,
  });
  if (directDmOutcome === "disabled") {
    logVerbose(core, runtime, `Blocked zalo DM from ${senderId} (dmPolicy=disabled)`);
    return undefined;
  }
  if (directDmOutcome === "unauthorized") {
    if (dmPolicy === "pairing") {
      await pairing.issueChallenge({
        senderId,
        senderIdLine: `Your Zalo user id: ${senderId}`,
        meta: { name: senderName ?? undefined },
        onCreated: () => {
          logVerbose(core, runtime, `zalo pairing request sender=${senderId}`);
        },
        sendPairingReply: async (text) => {
          await sendMessage(
            token,
            {
              chat_id: chatId,
              text,
            },
            fetcher,
          );
          statusSink?.({ lastOutboundAt: Date.now() });
        },
        onReplyError: (err) => {
          logVerbose(core, runtime, `zalo pairing reply failed for ${senderId}: ${String(err)}`);
        },
      });
    } else {
      logVerbose(
        core,
        runtime,
        `Blocked unauthorized zalo sender ${senderId} (dmPolicy=${dmPolicy})`,
      );
    }
    return undefined;
  }

  return {
    chatId,
    commandAuthorized,
    isGroup,
    rawBody,
    senderId,
    senderName,
  };
}

async function processMessageWithPipeline(params: ZaloMessagePipelineParams): Promise<void> {
  const {
    message,
    token,
    account,
    config,
    runtime,
    core,
    mediaPath,
    mediaType,
    statusSink,
    fetcher,
    authorization: authorizationOverride,
  } = params;
  const { message_id, date } = message;
  const authorization =
    authorizationOverride ??
    (await authorizeZaloMessage({
      ...params,
      mediaPath,
      mediaType,
    }));
  if (!authorization) {
    return;
  }
  const { isGroup, chatId, senderId, senderName, rawBody, commandAuthorized } = authorization;

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config,
    channel: "zalo",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? ("group" as const) : ("direct" as const),
      id: chatId,
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `zalo: drop control command from unauthorized sender ${senderId}`);
    return;
  }

  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
  const { storePath, body } = buildEnvelope({
    channel: "Zalo",
    from: fromLabel,
    timestamp: date ? date * 1000 : undefined,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `zalo:group:${chatId}` : `zalo:${senderId}`,
    To: `zalo:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "zalo",
    Surface: "zalo",
    MessageSid: message_id,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    OriginatingChannel: "zalo",
    OriginatingTo: `zalo:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`zalo: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "zalo",
    accountId: account.accountId,
  });
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: config,
    agentId: route.agentId,
    channel: "zalo",
    accountId: account.accountId,
    typing: {
      start: async () => {
        await sendChatAction(
          token,
          {
            chat_id: chatId,
            action: "typing",
          },
          fetcher,
          ZALO_TYPING_TIMEOUT_MS,
        );
      },
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => logVerbose(core, runtime, message),
          channel: "zalo",
          action: "start",
          target: chatId,
          error: err,
        });
      },
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload) => {
        await deliverZaloReply({
          payload,
          token,
          chatId,
          runtime,
          core,
          config,
          webhookUrl: params.webhookUrl,
          webhookPath: params.webhookPath,
          proxyUrl: account.config.proxy,
          mediaMaxBytes: params.mediaMaxMb * 1024 * 1024,
          canHostMedia: params.canHostMedia,
          accountId: account.accountId,
          statusSink,
          fetcher,
          tableMode,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] Zalo ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

async function deliverZaloReply(params: {
  payload: OutboundReplyPayload;
  token: string;
  chatId: string;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  config: OpenClawConfig;
  webhookUrl?: string;
  webhookPath?: string;
  proxyUrl?: string;
  mediaMaxBytes: number;
  canHostMedia: boolean;
  accountId?: string;
  statusSink?: ZaloStatusSink;
  fetcher?: ZaloFetch;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const {
    payload,
    token,
    chatId,
    runtime,
    core,
    config,
    webhookUrl,
    webhookPath,
    proxyUrl,
    mediaMaxBytes,
    canHostMedia,
    accountId,
    statusSink,
    fetcher,
  } = params;
  const tableMode = params.tableMode ?? "code";
  const reply = resolveSendableOutboundReplyParts(payload, {
    text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode),
  });
  const chunkMode = core.channel.text.resolveChunkMode(config, "zalo", accountId);
  await deliverTextOrMediaReply({
    payload,
    text: reply.text,
    chunkText: (value) =>
      core.channel.text.chunkMarkdownTextWithMode(value, ZALO_TEXT_LIMIT, chunkMode),
    sendText: async (chunk) => {
      try {
        await sendMessage(token, { chat_id: chatId, text: chunk }, fetcher);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Zalo message send failed: ${String(err)}`);
      }
    },
    sendMedia: async ({ mediaUrl, caption }) => {
      const sendableMediaUrl =
        canHostMedia && webhookUrl && webhookPath
          ? await prepareHostedZaloMediaUrl({
              mediaUrl,
              webhookUrl,
              webhookPath,
              maxBytes: mediaMaxBytes,
              proxyUrl,
            })
          : mediaUrl;
      await sendPhoto(token, { chat_id: chatId, photo: sendableMediaUrl, caption }, fetcher);
      statusSink?.({ lastOutboundAt: Date.now() });
    },
    onMediaError: (error) => {
      runtime.error?.(
        `Zalo photo send failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
    },
  });
}

export async function monitorZaloProvider(options: ZaloMonitorOptions): Promise<void> {
  const {
    token,
    account,
    config,
    runtime,
    abortSignal,
    useWebhook,
    webhookUrl,
    webhookSecret,
    webhookPath,
    statusSink,
    fetcher: fetcherOverride,
  } = options;

  const core = getZaloRuntime();
  const effectiveMediaMaxMb = account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const fetcher = fetcherOverride ?? resolveZaloProxyFetch(account.config.proxy);
  const mode = useWebhook ? "webhook" : "polling";
  const effectiveWebhookUrl = normalizeWebhookUrl(webhookUrl ?? account.config.webhookUrl);
  const effectiveWebhookPath =
    effectiveWebhookUrl || webhookPath?.trim() || account.config.webhookPath?.trim()
      ? (resolveWebhookPath({
          webhookPath: webhookPath ?? account.config.webhookPath,
          webhookUrl: effectiveWebhookUrl,
          defaultPath: null,
        }) ?? undefined)
      : undefined;
  const canHostMedia = Boolean(effectiveWebhookUrl && effectiveWebhookPath);
  const hostedMediaRoutePath =
    canHostMedia && effectiveWebhookUrl
      ? resolveHostedZaloMediaRoutePrefix({
          webhookUrl: effectiveWebhookUrl,
          webhookPath: effectiveWebhookPath,
        })
      : undefined;

  let stopped = false;
  const stopHandlers: Array<() => void> = [];
  let cleanupWebhook: (() => Promise<void>) | undefined;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const handler of stopHandlers) {
      handler();
    }
  };
  const stopOnAbort = () => {
    if (!useWebhook) {
      stop();
    }
  };

  abortSignal.addEventListener("abort", stopOnAbort, { once: true });

  runtime.log?.(
    `[${account.accountId}] Zalo provider init mode=${mode} mediaMaxMb=${String(effectiveMediaMaxMb)}`,
  );

  try {
    if (hostedMediaRoutePath) {
      const unregisterHostedMediaRoute = registerSharedHostedMediaRoute({
        path: hostedMediaRoutePath,
        accountId: account.accountId,
        log: runtime.log,
      });
      stopHandlers.push(unregisterHostedMediaRoute);
    }

    if (useWebhook) {
      const { registerZaloWebhookTarget } = await loadZaloWebhookModule();
      if (!effectiveWebhookUrl || !webhookSecret) {
        throw new Error("Zalo webhookUrl and webhookSecret are required for webhook mode");
      }
      if (!effectiveWebhookUrl.startsWith("https://")) {
        throw new Error("Zalo webhook URL must use HTTPS");
      }
      if (webhookSecret.length < 8 || webhookSecret.length > 256) {
        throw new Error("Zalo webhook secret must be 8-256 characters");
      }

      const path = effectiveWebhookPath;
      if (!path) {
        throw new Error("Zalo webhookPath could not be derived");
      }

      runtime.log?.(
        `[${account.accountId}] Zalo configuring webhook path=${path} target=${describeWebhookTarget(effectiveWebhookUrl)}`,
      );
      await setWebhook(token, { url: effectiveWebhookUrl, secret_token: webhookSecret }, fetcher);
      let webhookCleanupPromise: Promise<void> | undefined;
      cleanupWebhook = async () => {
        if (!webhookCleanupPromise) {
          webhookCleanupPromise = (async () => {
            runtime.log?.(`[${account.accountId}] Zalo stopping; deleting webhook`);
            try {
              await deleteWebhook(token, fetcher, WEBHOOK_CLEANUP_TIMEOUT_MS);
              runtime.log?.(`[${account.accountId}] Zalo webhook deleted`);
            } catch (err) {
              const detail =
                err instanceof Error && err.name === "AbortError"
                  ? `timed out after ${String(WEBHOOK_CLEANUP_TIMEOUT_MS)}ms`
                  : formatZaloError(err);
              runtime.error?.(`[${account.accountId}] Zalo webhook delete failed: ${detail}`);
            }
          })();
        }
        await webhookCleanupPromise;
      };
      runtime.log?.(`[${account.accountId}] Zalo webhook registered path=${path}`);

      const unregister = registerZaloWebhookTarget(
        {
          token,
          account,
          config,
          runtime,
          core,
          path,
          webhookUrl: effectiveWebhookUrl,
          webhookPath: path,
          secret: webhookSecret,
          statusSink: (patch) => statusSink?.(patch),
          mediaMaxMb: effectiveMediaMaxMb,
          canHostMedia,
          fetcher,
        },
        {
          route: {
            auth: "plugin",
            match: "exact",
            pluginId: "zalo",
            source: "zalo-webhook",
            accountId: account.accountId,
            log: runtime.log,
            handler: async (req, res) => {
              const handled = await handleZaloWebhookRequest(req, res);
              if (!handled && !res.headersSent) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("Not Found");
              }
            },
          },
        },
      );
      stopHandlers.push(unregister);
      await waitForAbortSignal(abortSignal);
      return;
    }

    runtime.log?.(`[${account.accountId}] Zalo polling mode: clearing webhook before startup`);
    try {
      try {
        const currentWebhookUrl = normalizeWebhookUrl(
          (await getWebhookInfo(token, fetcher)).result?.url,
        );
        if (!currentWebhookUrl) {
          runtime.log?.(`[${account.accountId}] Zalo polling mode ready (no webhook configured)`);
        } else {
          runtime.log?.(
            `[${account.accountId}] Zalo polling mode disabling existing webhook ${describeWebhookTarget(currentWebhookUrl)}`,
          );
          await deleteWebhook(token, fetcher);
          runtime.log?.(`[${account.accountId}] Zalo polling mode ready (webhook disabled)`);
        }
      } catch (err) {
        if (err instanceof ZaloApiError && err.errorCode === 404) {
          // Some Zalo environments do not expose webhook inspection for polling bots.
          runtime.log?.(
            `[${account.accountId}] Zalo polling mode webhook inspection unavailable; continuing without webhook cleanup`,
          );
        } else {
          throw err;
        }
      }
    } catch (err) {
      runtime.error?.(
        `[${account.accountId}] Zalo polling startup could not clear webhook: ${formatZaloError(err)}`,
      );
    }

    startPollingLoop({
      token,
      account,
      config,
      runtime,
      core,
      canHostMedia,
      webhookUrl: effectiveWebhookUrl,
      webhookPath: effectiveWebhookPath,
      abortSignal,
      isStopped: () => stopped,
      mediaMaxMb: effectiveMediaMaxMb,
      statusSink,
      fetcher,
    });

    await waitForAbortSignal(abortSignal);
  } catch (err) {
    runtime.error?.(
      `[${account.accountId}] Zalo provider startup failed mode=${mode}: ${formatZaloError(err)}`,
    );
    throw err;
  } finally {
    abortSignal.removeEventListener("abort", stopOnAbort);
    await cleanupWebhook?.();
    stop();
    runtime.log?.(`[${account.accountId}] Zalo provider stopped mode=${mode}`);
  }
}

export const __testing = {
  evaluateZaloGroupAccess,
  resolveZaloRuntimeGroupPolicy,
  clearHostedMediaRouteRefsForTest: () => hostedMediaRouteRefs.clear(),
};
