import type { Request, Response } from "express";
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import type { ClawdbotConfig } from "../config/types.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import {
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildMSTeamsAttachmentPlaceholder,
  buildMSTeamsGraphMessageUrls,
  buildMSTeamsMediaPayload,
  downloadMSTeamsGraphMedia,
  downloadMSTeamsImageAttachments,
  type MSTeamsAttachmentLike,
  summarizeMSTeamsHtmlAttachments,
} from "./attachments.js";
import type {
  MSTeamsConversationStore,
  StoredConversationReference,
} from "./conversation-store.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import {
  extractMSTeamsConversationMessageId,
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "./inbound.js";
import {
  type MSTeamsAdapter,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import {
  resolveMSTeamsReplyPolicy,
  resolveMSTeamsRouteConfig,
} from "./policy.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { resolveMSTeamsCredentials } from "./token.js";

const log = getChildLogger({ name: "msteams" });

export type MonitorMSTeamsOpts = {
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  conversationStore?: MSTeamsConversationStore;
};

export type MonitorMSTeamsResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

export async function monitorMSTeamsProvider(
  opts: MonitorMSTeamsOpts,
): Promise<MonitorMSTeamsResult> {
  const cfg = opts.cfg;
  const msteamsCfg = cfg.msteams;
  if (!msteamsCfg?.enabled) {
    log.debug("msteams provider disabled");
    return { app: null, shutdown: async () => {} };
  }

  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    log.error("msteams credentials not configured");
    return { app: null, shutdown: async () => {} };
  }
  const appId = creds.appId; // Extract for use in closures

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const port = msteamsCfg.webhook?.port ?? 3978;
  const textLimit = resolveTextChunkLimit(cfg, "msteams");
  const MB = 1024 * 1024;
  const mediaMaxBytes =
    typeof cfg.agent?.mediaMaxMb === "number" && cfg.agent.mediaMaxMb > 0
      ? Math.floor(cfg.agent.mediaMaxMb * MB)
      : 8 * MB;
  const conversationStore =
    opts.conversationStore ?? createMSTeamsConversationStoreFs();

  log.info(`starting provider (port ${port})`);

  // Dynamic import to avoid loading SDK when provider is disabled
  const agentsHosting = await import("@microsoft/agents-hosting");
  const express = await import("express");

  const {
    ActivityHandler,
    CloudAdapter,
    MsalTokenProvider,
    authorizeJWT,
    getAuthConfigWithDefaults,
  } = agentsHosting;

  // Auth configuration - create early so adapter is available for deliverReplies
  const authConfig = getAuthConfigWithDefaults({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
  });
  const tokenProvider = new MsalTokenProvider(authConfig);
  const adapter = new CloudAdapter(authConfig);

  // Handler for incoming messages
  async function handleTeamsMessage(context: MSTeamsTurnContext) {
    const activity = context.activity;
    const rawText = activity.text?.trim() ?? "";
    const text = stripMSTeamsMentionTags(rawText);
    const attachments = Array.isArray(activity.attachments)
      ? (activity.attachments as unknown as MSTeamsAttachmentLike[])
      : [];
    const attachmentPlaceholder =
      buildMSTeamsAttachmentPlaceholder(attachments);
    const rawBody = text || attachmentPlaceholder;
    const from = activity.from;
    const conversation = activity.conversation;

    const attachmentTypes = attachments
      .map((att) =>
        typeof att.contentType === "string" ? att.contentType : undefined,
      )
      .filter(Boolean)
      .slice(0, 3);
    const htmlSummary = summarizeMSTeamsHtmlAttachments(attachments);

    log.info("received message", {
      rawText: rawText.slice(0, 50),
      text: text.slice(0, 50),
      attachments: attachments.length,
      attachmentTypes,
      from: from?.id,
      conversation: conversation?.id,
    });
    if (htmlSummary) {
      log.debug("html attachment summary", htmlSummary);
    }

    if (!rawBody) {
      log.debug("skipping empty message after stripping mentions");
      return;
    }
    if (!from?.id) {
      log.debug("skipping message without from.id");
      return;
    }

    // Teams conversation.id may include ";messageid=..." suffix - strip it for session key
    const rawConversationId = conversation?.id ?? "";
    const conversationId = normalizeMSTeamsConversationId(rawConversationId);
    const conversationMessageId =
      extractMSTeamsConversationMessageId(rawConversationId);
    const conversationType = conversation?.conversationType ?? "personal";
    const isGroupChat =
      conversationType === "groupChat" || conversation?.isGroup === true;
    const isChannel = conversationType === "channel";
    const isDirectMessage = !isGroupChat && !isChannel;

    const senderName = from.name ?? from.id;
    const senderId = from.aadObjectId ?? from.id;

    // Save conversation reference for proactive messaging
    const agent = activity.recipient
      ? {
          id: activity.recipient.id,
          name: activity.recipient.name,
          aadObjectId: activity.recipient.aadObjectId,
        }
      : undefined;
    const conversationRef: StoredConversationReference = {
      activityId: activity.id,
      user: { id: from.id, name: from.name, aadObjectId: from.aadObjectId },
      agent,
      bot: agent ? { id: agent.id, name: agent.name } : undefined,
      conversation: {
        id: conversationId,
        conversationType,
        tenantId: conversation?.tenantId,
      },
      channelId: activity.channelId,
      serviceUrl: activity.serviceUrl,
    };
    conversationStore.upsert(conversationId, conversationRef).catch((err) => {
      log.debug("failed to save conversation reference", {
        error: formatUnknownError(err),
      });
    });

    // Build Teams-specific identifiers
    const teamsFrom = isDirectMessage
      ? `msteams:${senderId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`;
    const teamsTo = isDirectMessage
      ? `user:${senderId}`
      : `conversation:${conversationId}`;

    // Resolve routing
    const route = resolveAgentRoute({
      cfg,
      provider: "msteams",
      peer: {
        kind: isDirectMessage ? "dm" : isChannel ? "channel" : "group",
        id: isDirectMessage ? senderId : conversationId,
      },
    });

    const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isDirectMessage
      ? `Teams DM from ${senderName}`
      : `Teams message in ${conversationType} from ${senderName}`;

    enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`,
    });

    // Check DM policy for direct messages
    if (isDirectMessage && msteamsCfg) {
      const dmPolicy = msteamsCfg.dmPolicy ?? "pairing";
      const allowFrom = msteamsCfg.allowFrom ?? [];

      if (dmPolicy === "disabled") {
        log.debug("dropping dm (dms disabled)");
        return;
      }

      if (dmPolicy !== "open") {
        // Check allowlist - look up from config and pairing store
        const storedAllowFrom = await readProviderAllowFromStore("msteams");
        const effectiveAllowFrom = [
          ...allowFrom.map((v) => String(v).toLowerCase()),
          ...storedAllowFrom.map((v) => v.toLowerCase()),
        ];

        const senderLower = senderId.toLowerCase();
        const permitted = effectiveAllowFrom.some(
          (entry) => entry === senderLower || entry === "*",
        );

        if (!permitted) {
          if (dmPolicy === "pairing") {
            const { code, created } = await upsertProviderPairingRequest({
              provider: "msteams",
              id: senderId,
              meta: { name: senderName },
            });
            const msg = created
              ? `👋 Hi ${senderName}! To chat with me, please share this pairing code with my owner: **${code}**`
              : `🔑 Your pairing code is: **${code}** — please share it with my owner to get access.`;
            await context.sendActivity(msg);
            log.info("sent pairing code", { senderId, code });
          } else {
            log.debug("dropping unauthorized dm", { senderId, dmPolicy });
          }
          return;
        }
      }
    }

    // Resolve team/channel config for channels and group chats
    const teamId = activity.channelData?.team?.id;
    const channelId = conversationId;
    const { teamConfig, channelConfig } = resolveMSTeamsRouteConfig({
      cfg: msteamsCfg,
      teamId,
      conversationId: channelId,
    });
    const { requireMention, replyStyle } = resolveMSTeamsReplyPolicy({
      isDirectMessage,
      globalConfig: msteamsCfg,
      teamConfig,
      channelConfig,
    });

    // Check requireMention for channels and group chats
    if (!isDirectMessage) {
      const mentioned = wasMSTeamsBotMentioned(activity);

      if (requireMention && !mentioned) {
        log.debug("skipping message (mention required)", {
          teamId,
          channelId,
          requireMention,
          mentioned,
        });
        return;
      }
    }

    // Format the message body with envelope
    const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);
    let mediaList = await downloadMSTeamsImageAttachments({
      attachments,
      maxBytes: mediaMaxBytes,
      tokenProvider: {
        getAccessToken: (scope) => tokenProvider.getAccessToken(scope),
      },
    });
    if (mediaList.length === 0) {
      const onlyHtmlAttachments =
        attachments.length > 0 &&
        attachments.every((att) =>
          String(att.contentType ?? "").startsWith("text/html"),
        );
      if (onlyHtmlAttachments) {
        const messageUrls = buildMSTeamsGraphMessageUrls({
          conversationType,
          conversationId,
          messageId: activity.id ?? undefined,
          replyToId: activity.replyToId ?? undefined,
          conversationMessageId,
          channelData: activity.channelData,
        });
        if (messageUrls.length === 0) {
          log.debug("graph message url unavailable", {
            conversationType,
            hasChannelData: Boolean(activity.channelData),
            messageId: activity.id ?? undefined,
            replyToId: activity.replyToId ?? undefined,
          });
        } else {
          const attempts: Array<{
            url: string;
            hostedStatus?: number;
            attachmentStatus?: number;
            hostedCount?: number;
            attachmentCount?: number;
            tokenError?: boolean;
          }> = [];
          for (const messageUrl of messageUrls) {
            const graphMedia = await downloadMSTeamsGraphMedia({
              messageUrl,
              tokenProvider: {
                getAccessToken: (scope) => tokenProvider.getAccessToken(scope),
              },
              maxBytes: mediaMaxBytes,
            });
            attempts.push({
              url: messageUrl,
              hostedStatus: graphMedia.hostedStatus,
              attachmentStatus: graphMedia.attachmentStatus,
              hostedCount: graphMedia.hostedCount,
              attachmentCount: graphMedia.attachmentCount,
              tokenError: graphMedia.tokenError,
            });
            if (graphMedia.media.length > 0) {
              mediaList = graphMedia.media;
              break;
            }
            if (graphMedia.tokenError) break;
          }
          if (mediaList.length === 0) {
            log.debug("graph media fetch empty", { attempts });
          }
        }
      }
    }
    if (mediaList.length > 0) {
      log.debug("downloaded image attachments", { count: mediaList.length });
    } else if (htmlSummary?.imgTags) {
      log.debug("inline images detected but none downloaded", {
        imgTags: htmlSummary.imgTags,
        srcHosts: htmlSummary.srcHosts,
        dataImages: htmlSummary.dataImages,
        cidImages: htmlSummary.cidImages,
      });
    }
    const mediaPayload = buildMSTeamsMediaPayload(mediaList);
    const body = formatAgentEnvelope({
      provider: "Teams",
      from: senderName,
      timestamp,
      body: rawBody,
    });

    // Build context payload for agent
    const ctxPayload = {
      Body: body,
      From: teamsFrom,
      To: teamsTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isDirectMessage ? "direct" : isChannel ? "room" : "group",
      GroupSubject: !isDirectMessage ? conversationType : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "msteams" as const,
      Surface: "msteams" as const,
      MessageSid: activity.id,
      Timestamp: timestamp?.getTime() ?? Date.now(),
      WasMentioned: isDirectMessage || wasMSTeamsBotMentioned(activity),
      CommandAuthorized: true,
      OriginatingChannel: "msteams" as const,
      OriginatingTo: teamsTo,
      ...mediaPayload,
    };

    if (shouldLogVerbose()) {
      logVerbose(
        `msteams inbound: from=${ctxPayload.From} preview="${preview}"`,
      );
    }

    // Send typing indicator
    const sendTypingIndicator = async () => {
      try {
        await context.sendActivities([{ type: "typing" }]);
      } catch {
        // Typing indicator is best-effort
      }
    };

    // Create reply dispatcher
    const { dispatcher, replyOptions, markDispatchIdle } =
      createReplyDispatcherWithTyping({
        responsePrefix: cfg.messages?.responsePrefix,
        deliver: async (payload) => {
          const messages = renderReplyPayloadsToMessages([payload], {
            textChunkLimit: textLimit,
            chunkText: true,
            mediaMode: "split",
          });
          await sendMSTeamsMessages({
            replyStyle,
            adapter: adapter as unknown as MSTeamsAdapter,
            appId,
            conversationRef,
            context,
            messages,
            // Enable default retry/backoff for throttling/transient failures.
            retry: {},
            onRetry: (event) => {
              log.debug("retrying send", {
                replyStyle,
                ...event,
              });
            },
          });
        },
        onError: (err, info) => {
          const errMsg = formatUnknownError(err);
          const classification = classifyMSTeamsSendError(err);
          const hint = formatMSTeamsSendErrorHint(classification);
          runtime.error?.(
            danger(
              `msteams ${info.kind} reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`,
            ),
          );
          log.error("reply failed", {
            kind: info.kind,
            error: errMsg,
            classification,
            hint,
          });
        },
        onReplyStart: sendTypingIndicator,
      });

    // Dispatch to agent
    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      const { queuedFinal, counts } = await dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
      });

      markDispatchIdle();
      log.info("dispatch complete", { queuedFinal, counts });

      if (!queuedFinal) return;
      if (shouldLogVerbose()) {
        const finalCount = counts.final;
        logVerbose(
          `msteams: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${teamsTo}`,
        );
      }
    } catch (err) {
      log.error("dispatch failed", { error: String(err) });
      runtime.error?.(danger(`msteams dispatch failed: ${String(err)}`));
      // Try to send error message back to Teams
      try {
        await context.sendActivity(
          `⚠️ Agent failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // Best effort
      }
    }
  }

  // Create activity handler using fluent API
  const handler = new ActivityHandler()
    .onMessage(async (context, next) => {
      try {
        await handleTeamsMessage(context as unknown as MSTeamsTurnContext);
      } catch (err) {
        runtime.error?.(danger(`msteams handler failed: ${String(err)}`));
      }
      await next();
    })
    .onMembersAdded(async (context, next) => {
      const membersAdded = context.activity?.membersAdded ?? [];
      for (const member of membersAdded) {
        if (member.id !== context.activity?.recipient?.id) {
          log.debug("member added", { member: member.id });
          // Don't send welcome message - let the user initiate conversation
        }
      }
      await next();
    });

  // Create Express server
  const expressApp = express.default();
  expressApp.use(express.json());
  expressApp.use(authorizeJWT(authConfig));

  // Set up the messages endpoint - use configured path and /api/messages as fallback
  const configuredPath = msteamsCfg.webhook?.path ?? "/api/messages";
  const messageHandler = (req: Request, res: Response) => {
    void adapter
      .process(req, res, (context) => handler.run(context))
      .catch((err) => {
        log.error("msteams webhook failed", { error: formatUnknownError(err) });
      });
  };

  // Listen on configured path and /api/messages (standard Bot Framework path)
  expressApp.post(configuredPath, messageHandler);
  if (configuredPath !== "/api/messages") {
    expressApp.post("/api/messages", messageHandler);
  }

  log.debug("listening on paths", {
    primary: configuredPath,
    fallback: "/api/messages",
  });

  // Start listening and capture the HTTP server handle
  const httpServer = expressApp.listen(port, () => {
    log.info(`msteams provider started on port ${port}`);
  });

  httpServer.on("error", (err) => {
    log.error("msteams server error", { error: String(err) });
  });

  const shutdown = async () => {
    log.info("shutting down msteams provider");
    return new Promise<void>((resolve) => {
      httpServer.close((err) => {
        if (err) {
          log.debug("msteams server close error", { error: String(err) });
        }
        resolve();
      });
    });
  };

  // Handle abort signal
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => {
      void shutdown();
    });
  }

  return { app: expressApp, shutdown };
}
