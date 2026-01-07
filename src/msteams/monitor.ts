import {
  chunkMarkdownText,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
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
  saveConversationReference,
  type StoredConversationReference,
} from "./conversation-store.js";
import { resolveMSTeamsCredentials } from "./token.js";

const log = getChildLogger({ name: "msteams" });

export type MonitorMSTeamsOpts = {
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

export type MonitorMSTeamsResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

type TeamsActivity = {
  id?: string;
  type?: string;
  timestamp?: string | Date;
  text?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: {
    id?: string;
    conversationType?: string;
    tenantId?: string;
    isGroup?: boolean;
  };
  channelId?: string;
  serviceUrl?: string;
  membersAdded?: Array<{ id?: string; name?: string }>;
  /** Entities including mentions */
  entities?: Array<{
    type?: string;
    mentioned?: { id?: string; name?: string };
  }>;
  /** Teams-specific channel data including team info */
  channelData?: {
    team?: { id?: string; name?: string };
    channel?: { id?: string; name?: string };
    tenant?: { id?: string };
  };
};

type TeamsTurnContext = {
  activity: TeamsActivity;
  sendActivity: (textOrActivity: string | object) => Promise<unknown>;
  sendActivities?: (
    activities: Array<{ type: string } & Record<string, unknown>>,
  ) => Promise<unknown>;
};

// Helper to convert timestamp to Date
function parseTimestamp(ts?: string | Date): Date | undefined {
  if (!ts) return undefined;
  if (ts instanceof Date) return ts;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

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

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const port = msteamsCfg.webhook?.port ?? 3978;
  const textLimit = resolveTextChunkLimit(cfg, "msteams");

  log.info(`starting provider (port ${port})`);

  // Dynamic import to avoid loading SDK when provider is disabled
  const agentsHosting = await import("@microsoft/agents-hosting");
  const express = await import("express");

  const { ActivityHandler, CloudAdapter, authorizeJWT, getAuthConfigWithDefaults } =
    agentsHosting;

  // Helper to deliver replies via Teams SDK
  async function deliverReplies(params: {
    replies: ReplyPayload[];
    context: TeamsTurnContext;
  }) {
    const chunkLimit = Math.min(textLimit, 4000);
    for (const payload of params.replies) {
      const mediaList =
        payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      const text = payload.text ?? "";
      if (!text && mediaList.length === 0) continue;

      if (mediaList.length === 0) {
        for (const chunk of chunkMarkdownText(text, chunkLimit)) {
          const trimmed = chunk.trim();
          if (!trimmed || trimmed === SILENT_REPLY_TOKEN) continue;
          await params.context.sendActivity(trimmed);
        }
      } else {
        // For media, send text first then media URLs as separate messages
        if (text.trim() && text.trim() !== SILENT_REPLY_TOKEN) {
          for (const chunk of chunkMarkdownText(text, chunkLimit)) {
            await params.context.sendActivity(chunk);
          }
        }
        for (const mediaUrl of mediaList) {
          // Teams supports adaptive cards for rich media, but for now just send URL
          await params.context.sendActivity(mediaUrl);
        }
      }
    }
  }

  // Strip Teams @mention HTML tags from message text
  function stripMentionTags(text: string): string {
    // Teams wraps mentions in <at>...</at> tags
    return text.replace(/<at>.*?<\/at>/gi, "").trim();
  }

  // Check if the bot was mentioned in the activity
  function wasBotMentioned(activity: TeamsActivity): boolean {
    const botId = activity.recipient?.id;
    if (!botId) return false;
    const entities = activity.entities ?? [];
    return entities.some(
      (e) => e.type === "mention" && e.mentioned?.id === botId,
    );
  }

  // Handler for incoming messages
  async function handleTeamsMessage(context: TeamsTurnContext) {
    const activity = context.activity;
    const rawText = activity.text?.trim() ?? "";
    const text = stripMentionTags(rawText);
    const from = activity.from;
    const conversation = activity.conversation;

    log.info("received message", {
      rawText: rawText.slice(0, 50),
      text: text.slice(0, 50),
      from: from?.id,
      conversation: conversation?.id,
    });

    if (!text) {
      log.debug("skipping empty message after stripping mentions");
      return;
    }
    if (!from?.id) {
      log.debug("skipping message without from.id");
      return;
    }

    // Teams conversation.id may include ";messageid=..." suffix - strip it for session key
    const rawConversationId = conversation?.id ?? "";
    const conversationId = rawConversationId.split(";")[0];
    const conversationType = conversation?.conversationType ?? "personal";
    const isGroupChat =
      conversationType === "groupChat" || conversation?.isGroup === true;
    const isChannel = conversationType === "channel";
    const isDirectMessage = !isGroupChat && !isChannel;

    const senderName = from.name ?? from.id;
    const senderId = from.aadObjectId ?? from.id;

    // Save conversation reference for proactive messaging
    const conversationRef: StoredConversationReference = {
      activityId: activity.id,
      user: { id: from.id, name: from.name, aadObjectId: from.aadObjectId },
      bot: activity.recipient
        ? { id: activity.recipient.id, name: activity.recipient.name }
        : undefined,
      conversation: {
        id: conversationId,
        conversationType,
        tenantId: conversation?.tenantId,
      },
      channelId: activity.channelId,
      serviceUrl: activity.serviceUrl,
    };
    saveConversationReference(conversationId, conversationRef).catch((err) => {
      log.debug("failed to save conversation reference", { error: String(err) });
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

    const preview = text.replace(/\s+/g, " ").slice(0, 160);
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

    // Check requireMention for channels and group chats
    if (!isDirectMessage) {
      const teamId = activity.channelData?.team?.id;
      const channelId = conversationId;

      // Resolution order: channel config > team config > global config > default (true)
      const teamConfig = teamId ? msteamsCfg?.teams?.[teamId] : undefined;
      const channelConfig = teamConfig?.channels?.[channelId];

      const requireMention =
        channelConfig?.requireMention ??
        teamConfig?.requireMention ??
        msteamsCfg?.requireMention ??
        true;

      const mentioned = wasBotMentioned(activity);

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
    const timestamp = parseTimestamp(activity.timestamp);
    const body = formatAgentEnvelope({
      provider: "Teams",
      from: senderName,
      timestamp,
      body: text,
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
      WasMentioned: isDirectMessage || wasBotMentioned(activity),
      CommandAuthorized: true,
      OriginatingChannel: "msteams" as const,
      OriginatingTo: teamsTo,
    };

    if (shouldLogVerbose()) {
      logVerbose(
        `msteams inbound: from=${ctxPayload.From} preview="${preview}"`,
      );
    }

    // Send typing indicator
    const sendTypingIndicator = async () => {
      try {
        if (context.sendActivities) {
          await context.sendActivities([{ type: "typing" }]);
        }
      } catch {
        // Typing indicator is best-effort
      }
    };

    // Create reply dispatcher
    const { dispatcher, replyOptions, markDispatchIdle } =
      createReplyDispatcherWithTyping({
        responsePrefix: cfg.messages?.responsePrefix,
        deliver: async (payload) => {
          await deliverReplies({
            replies: [payload],
            context,
          });
        },
        onError: (err, info) => {
          const errMsg =
            err instanceof Error
              ? err.message
              : typeof err === "object"
                ? JSON.stringify(err)
                : String(err);
          runtime.error?.(
            danger(`msteams ${info.kind} reply failed: ${errMsg}`),
          );
          log.error("reply failed", { kind: info.kind, error: err });
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
  // The SDK's TurnContext is compatible with our TeamsTurnContext
  const handler = new ActivityHandler()
    .onMessage(async (context, next) => {
      try {
        await handleTeamsMessage(context as unknown as TeamsTurnContext);
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

  // Auth configuration - use SDK's defaults merger
  const authConfig = getAuthConfigWithDefaults({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
  });

  // Create our own Express server (instead of using startServer) so we can control shutdown
  // Pass authConfig to CloudAdapter so it can authenticate outbound calls
  const adapter = new CloudAdapter(authConfig);
  const expressApp = express.default();
  expressApp.use(express.json());
  expressApp.use(authorizeJWT(authConfig));

  // Set up the messages endpoint - use configured path and /api/messages as fallback
  const configuredPath = msteamsCfg.webhook?.path ?? "/api/messages";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messageHandler = (req: any, res: any) => {
    adapter.process(req, res, (context) => handler.run(context));
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
