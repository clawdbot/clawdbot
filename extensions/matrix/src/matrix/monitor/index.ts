import type { MatrixEvent, Room } from "matrix-js-sdk";
import { EventType, RelationType, RoomEvent } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events.js";

import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../../../../src/agents/identity.js";
import { chunkMarkdownText, resolveTextChunkLimit } from "../../../../../src/auto-reply/chunk.js";
import { hasControlCommand } from "../../../../../src/auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../../../../src/auto-reply/commands-registry.js";
import { formatAgentEnvelope } from "../../../../../src/auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../../../../../src/auto-reply/reply/dispatch-from-config.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
} from "../../../../../src/auto-reply/reply/mentions.js";
import { createReplyDispatcherWithTyping } from "../../../../../src/auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../../../../../src/auto-reply/types.js";
import { loadConfig } from "../../../../../src/config/config.js";
import { resolveStorePath, updateLastRoute } from "../../../../../src/config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../../../../src/globals.js";
import { enqueueSystemEvent } from "../../../../../src/infra/system-events.js";
import { getChildLogger } from "../../../../../src/logging.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../../../../src/pairing/pairing-store.js";
import { resolveAgentRoute } from "../../../../../src/routing/resolve-route.js";
import type { RuntimeEnv } from "../../../../../src/runtime.js";
import type { CoreConfig, ReplyToMode } from "../../types.js";
import { setActiveMatrixClient } from "../active-client.js";
import {
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
} from "../client.js";
import {
  formatPollAsText,
  isPollStartType,
  type PollStartContent,
  parsePollStartContent,
} from "../poll-types.js";
import { reactMatrixMessage, sendMessageMatrix, sendTypingMatrix } from "../send.js";
import { resolveMatrixAllowListMatches, normalizeAllowListLower } from "./allowlist.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { createDirectRoomTracker } from "./direct.js";
import { downloadMatrixMedia } from "./media.js";
import { resolveMentions } from "./mentions.js";
import { deliverMatrixReplies } from "./replies.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixThreadRootId, resolveMatrixThreadTarget } from "./threads.js";

export type MonitorMatrixOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  initialSyncLimit?: number;
  replyToMode?: ReplyToMode;
};

const DEFAULT_MEDIA_MAX_MB = 20;

export async function monitorMatrixProvider(opts: MonitorMatrixOpts = {}): Promise<void> {
  if (isBunRuntime()) {
    throw new Error("Matrix provider requires Node (bun runtime not supported)");
  }
  const cfg = loadConfig() as CoreConfig;
  if (cfg.channels?.matrix?.enabled === false) return;

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const auth = await resolveMatrixAuth({ cfg });
  const resolvedInitialSyncLimit =
    typeof opts.initialSyncLimit === "number"
      ? Math.max(0, Math.floor(opts.initialSyncLimit))
      : auth.initialSyncLimit;
  const authWithLimit =
    resolvedInitialSyncLimit === auth.initialSyncLimit
      ? auth
      : { ...auth, initialSyncLimit: resolvedInitialSyncLimit };
  const client = await resolveSharedMatrixClient({
    cfg,
    auth: authWithLimit,
    startClient: false,
  });
  setActiveMatrixClient(client);

  const mentionRegexes = buildMentionRegexes(cfg);
  const logger = getChildLogger({ module: "matrix-auto-reply" });
  const allowlistOnly = cfg.channels?.matrix?.allowlistOnly === true;
  const groupPolicyRaw = cfg.channels?.matrix?.groupPolicy ?? "allowlist";
  const groupPolicy = allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
  const replyToMode = opts.replyToMode ?? cfg.channels?.matrix?.replyToMode ?? "off";
  const threadReplies = cfg.channels?.matrix?.threadReplies ?? "inbound";
  const dmConfig = cfg.channels?.matrix?.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicyRaw = dmConfig?.policy ?? "pairing";
  const dmPolicy = allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const allowFrom = dmConfig?.allowFrom ?? [];
  const textLimit = resolveTextChunkLimit(cfg, "matrix");
  const mediaMaxMb = opts.mediaMaxMb ?? cfg.channels?.matrix?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const startupMs = Date.now();
  const startupGraceMs = 0;
  const directTracker = createDirectRoomTracker(client);
  registerMatrixAutoJoin({ client, cfg, runtime });

  const handleTimeline = async (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline?: boolean,
  ) => {
    try {
      if (!room) return;
      if (toStartOfTimeline) return;
      if (event.getType() === EventType.RoomMessageEncrypted || event.isDecryptionFailure()) {
        return;
      }

      const eventType = event.getType();
      const isPollEvent = isPollStartType(eventType);
      if (eventType !== EventType.RoomMessage && !isPollEvent) return;
      if (event.isRedacted()) return;
      const senderId = event.getSender();
      if (!senderId) return;
      if (senderId === client.getUserId()) return;
      const eventTs = event.getTs();
      const eventAge = event.getAge();
      if (typeof eventTs === "number" && eventTs < startupMs - startupGraceMs) {
        return;
      }
      if (
        typeof eventTs !== "number" &&
        typeof eventAge === "number" &&
        eventAge > startupGraceMs
      ) {
        return;
      }

      let content = event.getContent<RoomMessageEventContent>();
      if (isPollEvent) {
        const pollStartContent = event.getContent<PollStartContent>();
        const pollSummary = parsePollStartContent(pollStartContent);
        if (pollSummary) {
          pollSummary.eventId = event.getId() ?? "";
          pollSummary.roomId = room.roomId;
          pollSummary.sender = senderId;
          pollSummary.senderName = room.getMember(senderId)?.name ?? senderId;
          const pollText = formatPollAsText(pollSummary);
          content = {
            msgtype: "m.text",
            body: pollText,
          } as unknown as RoomMessageEventContent;
        } else {
          return;
        }
      }

      const relates = content["m.relates_to"];
      if (relates && "rel_type" in relates) {
        if (relates.rel_type === RelationType.Replace) return;
      }

      const roomId = room.roomId;
      const isDirectMessage = directTracker.isDirectMessage(room, senderId);
      const isRoom = !isDirectMessage;

      if (!isDirectMessage && groupPolicy === "disabled") return;

      const roomAliases = [
        room.getCanonicalAlias?.() ?? "",
        ...(room.getAltAliases?.() ?? []),
      ].filter(Boolean);
      const roomName = room.name ?? undefined;
      const roomConfigInfo = resolveMatrixRoomConfig({
        rooms: cfg.channels?.matrix?.rooms,
        roomId,
        aliases: roomAliases,
        name: roomName,
      });

      if (roomConfigInfo.config && !roomConfigInfo.allowed) {
        logVerbose(`matrix: room disabled room=${roomId}`);
        return;
      }
      if (groupPolicy === "allowlist") {
        if (!roomConfigInfo.allowlistConfigured) {
          logVerbose("matrix: drop room message (no allowlist)");
          return;
        }
        if (!roomConfigInfo.config) {
          logVerbose("matrix: drop room message (not in allowlist)");
          return;
        }
      }

      const senderName = room.getMember(senderId)?.name ?? senderId;
      const storeAllowFrom = await readChannelAllowFromStore("matrix").catch(() => []);
      const effectiveAllowFrom = normalizeAllowListLower([...allowFrom, ...storeAllowFrom]);

      if (isDirectMessage) {
        if (!dmEnabled || dmPolicy === "disabled") return;
        if (dmPolicy !== "open") {
          const permitted =
            effectiveAllowFrom.length > 0 &&
            resolveMatrixAllowListMatches({
              allowList: effectiveAllowFrom,
              userId: senderId,
              userName: senderName,
            });
          if (!permitted) {
            if (dmPolicy === "pairing") {
              const { code, created } = await upsertChannelPairingRequest({
                channel: "matrix",
                id: senderId,
                meta: { name: senderName },
              });
              if (created) {
                try {
                  await sendMessageMatrix(
                    `room:${roomId}`,
                    [
                      "Clawdbot: access not configured.",
                      "",
                      `Pairing code: ${code}`,
                      "",
                      "Ask the bot owner to approve with:",
                      "clawdbot pairing approve matrix <code>",
                    ].join("\n"),
                    { client },
                  );
                } catch (err) {
                  logVerbose(`matrix pairing reply failed for ${senderId}: ${String(err)}`);
                }
              }
            }
            return;
          }
        }
      }

      if (isRoom && roomConfigInfo.config?.users?.length) {
        const userAllowed = resolveMatrixAllowListMatches({
          allowList: normalizeAllowListLower(roomConfigInfo.config.users),
          userId: senderId,
          userName: senderName,
        });
        if (!userAllowed) {
          logVerbose(`matrix: blocked sender ${senderId} (room users allowlist)`);
          return;
        }
      }

      const rawBody = content.body.trim();
      let media: {
        path: string;
        contentType?: string;
        placeholder: string;
      } | null = null;
      const contentUrl =
        "url" in content && typeof content.url === "string" ? content.url : undefined;
      if (!rawBody && !contentUrl) {
        return;
      }

      const contentType =
        "info" in content && content.info && "mimetype" in content.info
          ? (content.info as { mimetype?: string }).mimetype
          : undefined;
      if (contentUrl?.startsWith("mxc://")) {
        try {
          media = await downloadMatrixMedia({
            client,
            mxcUrl: contentUrl,
            contentType,
            maxBytes: mediaMaxBytes,
          });
        } catch (err) {
          logVerbose(`matrix: media download failed: ${String(err)}`);
        }
      }

      const bodyText = rawBody || media?.placeholder || "";
      if (!bodyText) return;

      const { wasMentioned, hasExplicitMention } = resolveMentions({
        content,
        userId: client.getUserId(),
        text: bodyText,
        mentionRegexes,
      });
      const commandAuthorized =
        (!allowlistOnly && effectiveAllowFrom.length === 0) ||
        resolveMatrixAllowListMatches({
          allowList: effectiveAllowFrom,
          userId: senderId,
          userName: senderName,
        });
      const allowTextCommands = shouldHandleTextCommands({
        cfg,
        surface: "matrix",
      });
      const shouldRequireMention = isRoom
        ? roomConfigInfo.config?.autoReply === true
          ? false
          : roomConfigInfo.config?.autoReply === false
            ? true
            : typeof roomConfigInfo.config?.requireMention === "boolean"
              ? roomConfigInfo.config.requireMention
              : true
        : false;
      const shouldBypassMention =
        allowTextCommands &&
        isRoom &&
        shouldRequireMention &&
        !wasMentioned &&
        !hasExplicitMention &&
        commandAuthorized &&
        hasControlCommand(bodyText);
      if (isRoom && shouldRequireMention && !wasMentioned && !shouldBypassMention) {
        logger.info({ roomId, reason: "no-mention" }, "skipping room message");
        return;
      }

      const messageId = event.getId() ?? "";
      const threadRootId = resolveMatrixThreadRootId({ event, content });
      const threadTarget = resolveMatrixThreadTarget({
        threadReplies,
        messageId,
        threadRootId,
        isThreadRoot: event.isThreadRoot,
      });

      const textWithId = `${bodyText}\n[matrix event id: ${messageId} room: ${roomId}]`;
      const body = formatAgentEnvelope({
        channel: "Matrix",
        from: senderName,
        timestamp: event.getTs() ?? undefined,
        body: textWithId,
      });

      const route = resolveAgentRoute({
        cfg,
        channel: "matrix",
        peer: {
          kind: isDirectMessage ? "dm" : "channel",
          id: isDirectMessage ? senderId : roomId,
        },
      });

      const groupSystemPrompt = roomConfigInfo.config?.systemPrompt?.trim() || undefined;
      const ctxPayload = {
        Body: body,
        From: isDirectMessage ? `matrix:${senderId}` : `matrix:channel:${roomId}`,
        To: `room:${roomId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isDirectMessage ? "direct" : "room",
        SenderName: senderName,
        SenderId: senderId,
        SenderUsername: senderId.split(":")[0]?.replace(/^@/, ""),
        GroupSubject: isRoom ? (roomName ?? roomId) : undefined,
        GroupRoom: isRoom ? (room.getCanonicalAlias?.() ?? roomId) : undefined,
        GroupSystemPrompt: isRoom ? groupSystemPrompt : undefined,
        Provider: "matrix" as const,
        Surface: "matrix" as const,
        WasMentioned: isRoom ? wasMentioned : undefined,
        MessageSid: messageId,
        ReplyToId: threadTarget ? undefined : (event.replyEventId ?? undefined),
        MessageThreadId: threadTarget,
        Timestamp: event.getTs() ?? undefined,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        CommandAuthorized: commandAuthorized,
        CommandSource: "text" as const,
        OriginatingChannel: "matrix" as const,
        OriginatingTo: `room:${roomId}`,
      };

      if (isDirectMessage) {
        const storePath = resolveStorePath(cfg.session?.store, {
          agentId: route.agentId,
        });
        await updateLastRoute({
          storePath,
          sessionKey: route.mainSessionKey,
          channel: "matrix",
          to: `room:${roomId}`,
          accountId: route.accountId,
        });
      }

      if (shouldLogVerbose()) {
        const preview = bodyText.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(`matrix inbound: room=${roomId} from=${senderId} preview="${preview}"`);
      }

      const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
      const ackScope = cfg.messages?.ackReactionScope ?? "group-mentions";
      const shouldAckReaction = () => {
        if (!ackReaction) return false;
        if (ackScope === "all") return true;
        if (ackScope === "direct") return isDirectMessage;
        if (ackScope === "group-all") return isRoom;
        if (ackScope === "group-mentions") {
          if (!isRoom) return false;
          if (!shouldRequireMention) return false;
          return wasMentioned || shouldBypassMention;
        }
        return false;
      };
      if (shouldAckReaction() && messageId) {
        reactMatrixMessage(roomId, messageId, ackReaction, client).catch((err) => {
          logVerbose(`matrix react failed for room ${roomId}: ${String(err)}`);
        });
      }

      const replyTarget = ctxPayload.To;
      if (!replyTarget) {
        runtime.error?.(danger("matrix: missing reply target"));
        return;
      }

      let didSendReply = false;
      const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
        responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
        humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload) => {
          await deliverMatrixReplies({
            replies: [payload],
            roomId,
            client,
            runtime,
            textLimit,
            replyToMode,
            threadId: threadTarget,
          });
          didSendReply = true;
        },
        onError: (err, info) => {
          runtime.error?.(danger(`matrix ${info.kind} reply failed: ${String(err)}`));
        },
        onReplyStart: () => sendTypingMatrix(roomId, true, undefined, client).catch(() => {}),
        onIdle: () => sendTypingMatrix(roomId, false, undefined, client).catch(() => {}),
      });

      const { queuedFinal, counts } = await dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          skillFilter: roomConfigInfo.config?.skills,
        },
      });
      markDispatchIdle();
      if (!queuedFinal) return;
      didSendReply = true;
      if (shouldLogVerbose()) {
        const finalCount = counts.final;
        logVerbose(`matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`);
      }
      if (didSendReply) {
        const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
        enqueueSystemEvent(`Matrix message from ${senderName}: ${preview}`, {
          sessionKey: route.sessionKey,
          contextKey: `matrix:message:${roomId}:${messageId || "unknown"}`,
        });
      }
    } catch (err) {
      runtime.error?.(danger(`matrix handler failed: ${String(err)}`));
    }
  };

  client.on(RoomEvent.Timeline, handleTimeline);

  await resolveSharedMatrixClient({ cfg, auth: authWithLimit, startClient: true });
  runtime.log?.(`matrix: logged in as ${auth.userId}`);

  await new Promise<void>((resolve) => {
    const onAbort = () => {
      try {
        client.stopClient();
      } finally {
        setActiveMatrixClient(null);
        resolve();
      }
    };
    if (opts.abortSignal?.aborted) {
      onAbort();
      return;
    }
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
