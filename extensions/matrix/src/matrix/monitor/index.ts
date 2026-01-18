import type { MatrixEvent, Room } from "matrix-js-sdk";
import { EventType, RelationType, RoomEvent } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events.js";

import {
  buildMentionRegexes,
  chunkMarkdownText,
  createReplyDispatcherWithTyping,
  danger,
  dispatchReplyFromConfig,
  enqueueSystemEvent,
  finalizeInboundContext,
  formatAgentEnvelope,
  formatAllowlistMatchMeta,
  getChildLogger,
  hasControlCommand,
  loadConfig,
  logVerbose,
  mergeAllowlist,
  matchesMentionPatterns,
  readChannelAllowFromStore,
  recordSessionMetaFromInbound,
  resolveAgentRoute,
  resolveCommandAuthorizedFromAuthorizers,
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
  resolveStorePath,
  resolveTextChunkLimit,
  shouldHandleTextCommands,
  shouldLogVerbose,
  summarizeMapping,
  updateLastRoute,
  upsertChannelPairingRequest,
  type ReplyPayload,
  type RuntimeEnv,
} from "clawdbot/plugin-sdk";
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
import {
  resolveMatrixAllowListMatch,
  resolveMatrixAllowListMatches,
  normalizeAllowListLower,
} from "./allowlist.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { createDirectRoomTracker } from "./direct.js";
import { downloadMatrixMedia } from "./media.js";
import { resolveMentions } from "./mentions.js";
import { deliverMatrixReplies } from "./replies.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixThreadRootId, resolveMatrixThreadTarget } from "./threads.js";
import { resolveMatrixTargets } from "../../resolve-targets.js";

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
  let cfg = loadConfig() as CoreConfig;
  if (cfg.channels?.matrix?.enabled === false) return;

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const normalizeUserEntry = (raw: string) =>
    raw.replace(/^matrix:/i, "").replace(/^user:/i, "").trim();
  const normalizeRoomEntry = (raw: string) =>
    raw.replace(/^matrix:/i, "").replace(/^(room|channel):/i, "").trim();
  const isMatrixUserId = (value: string) => value.startsWith("@") && value.includes(":");

  let allowFrom = cfg.channels?.matrix?.dm?.allowFrom ?? [];
  let roomsConfig = cfg.channels?.matrix?.rooms;

  if (allowFrom.length > 0) {
    const entries = allowFrom
      .map((entry) => normalizeUserEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");
    if (entries.length > 0) {
      const mapping: string[] = [];
      const unresolved: string[] = [];
      const additions: string[] = [];
      const pending: string[] = [];
      for (const entry of entries) {
        if (isMatrixUserId(entry)) {
          additions.push(entry);
          continue;
        }
        pending.push(entry);
      }
      if (pending.length > 0) {
        const resolved = await resolveMatrixTargets({
          cfg,
          inputs: pending,
          kind: "user",
          runtime,
        });
        for (const entry of resolved) {
          if (entry.resolved && entry.id) {
            additions.push(entry.id);
            mapping.push(`${entry.input}→${entry.id}`);
          } else {
            unresolved.push(entry.input);
          }
        }
      }
      allowFrom = mergeAllowlist({ existing: allowFrom, additions });
      summarizeMapping("matrix users", mapping, unresolved, runtime);
    }
  }

  if (roomsConfig && Object.keys(roomsConfig).length > 0) {
    const entries = Object.keys(roomsConfig).filter((key) => key !== "*");
    const mapping: string[] = [];
    const unresolved: string[] = [];
    const nextRooms = { ...roomsConfig };
    const pending: Array<{ input: string; query: string }> = [];
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const cleaned = normalizeRoomEntry(trimmed);
      if (cleaned.startsWith("!") && cleaned.includes(":")) {
        if (!nextRooms[cleaned]) {
          nextRooms[cleaned] = roomsConfig[entry];
        }
        mapping.push(`${entry}→${cleaned}`);
        continue;
      }
      pending.push({ input: entry, query: trimmed });
    }
    if (pending.length > 0) {
      const resolved = await resolveMatrixTargets({
        cfg,
        inputs: pending.map((entry) => entry.query),
        kind: "group",
        runtime,
      });
      resolved.forEach((entry, index) => {
        const source = pending[index];
        if (!source) return;
        if (entry.resolved && entry.id) {
          if (!nextRooms[entry.id]) {
            nextRooms[entry.id] = roomsConfig[source.input];
          }
          mapping.push(`${source.input}→${entry.id}`);
        } else {
          unresolved.push(source.input);
        }
      });
    }
    roomsConfig = nextRooms;
    summarizeMapping("matrix rooms", mapping, unresolved, runtime);
  }

  cfg = {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...cfg.channels?.matrix,
        dm: {
          ...cfg.channels?.matrix?.dm,
          allowFrom,
        },
        rooms: roomsConfig,
      },
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
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicyRaw = cfg.channels?.matrix?.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
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
      const roomMatchMeta = `matchKey=${roomConfigInfo.matchKey ?? "none"} matchSource=${
        roomConfigInfo.matchSource ?? "none"
      }`;

      if (roomConfigInfo.config && !roomConfigInfo.allowed) {
        logVerbose(`matrix: room disabled room=${roomId} (${roomMatchMeta})`);
        return;
      }
      if (groupPolicy === "allowlist") {
        if (!roomConfigInfo.allowlistConfigured) {
          logVerbose(`matrix: drop room message (no allowlist, ${roomMatchMeta})`);
          return;
        }
        if (!roomConfigInfo.config) {
          logVerbose(`matrix: drop room message (not in allowlist, ${roomMatchMeta})`);
          return;
        }
      }

      const senderName = room.getMember(senderId)?.name ?? senderId;
      const storeAllowFrom = await readChannelAllowFromStore("matrix").catch(() => []);
      const effectiveAllowFrom = normalizeAllowListLower([...allowFrom, ...storeAllowFrom]);

      if (isDirectMessage) {
        if (!dmEnabled || dmPolicy === "disabled") return;
        if (dmPolicy !== "open") {
          const allowMatch = resolveMatrixAllowListMatch({
            allowList: effectiveAllowFrom,
            userId: senderId,
            userName: senderName,
          });
          const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);
          if (!allowMatch.allowed) {
            if (dmPolicy === "pairing") {
              const { code, created } = await upsertChannelPairingRequest({
                channel: "matrix",
                id: senderId,
                meta: { name: senderName },
              });
              if (created) {
                logVerbose(
                  `matrix pairing request sender=${senderId} name=${senderName ?? "unknown"} (${allowMatchMeta})`,
                );
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
            if (dmPolicy !== "pairing") {
              logVerbose(
                `matrix: blocked dm sender ${senderId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
              );
            }
            return;
          }
        }
      }

      if (isRoom && roomConfigInfo.config?.users?.length) {
        const userMatch = resolveMatrixAllowListMatch({
          allowList: normalizeAllowListLower(roomConfigInfo.config.users),
          userId: senderId,
          userName: senderName,
        });
        if (!userMatch.allowed) {
          logVerbose(
            `matrix: blocked sender ${senderId} (room users allowlist, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              userMatch,
            )})`,
          );
          return;
        }
      }
      if (isRoom) {
        logVerbose(`matrix: allow room ${roomId} (${roomMatchMeta})`);
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
      const allowTextCommands = shouldHandleTextCommands({
        cfg,
        surface: "matrix",
      });
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const senderAllowedForCommands = resolveMatrixAllowListMatches({
        allowList: effectiveAllowFrom,
        userId: senderId,
        userName: senderName,
      });
      const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      });
      if (isRoom && allowTextCommands && hasControlCommand(bodyText, cfg) && !commandAuthorized) {
        logVerbose(`matrix: drop control command from unauthorized sender ${senderId}`);
        return;
      }
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

	      const envelopeFrom = isDirectMessage ? senderName : (roomName ?? roomId);
	      const textWithId = `${bodyText}\n[matrix event id: ${messageId} room: ${roomId}]`;
	      const body = formatAgentEnvelope({
	        channel: "Matrix",
	        from: envelopeFrom,
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
      const ctxPayload = finalizeInboundContext({
	        Body: body,
	        RawBody: bodyText,
	        CommandBody: bodyText,
	        From: isDirectMessage ? `matrix:${senderId}` : `matrix:channel:${roomId}`,
	        To: `room:${roomId}`,
	        SessionKey: route.sessionKey,
	        AccountId: route.accountId,
        ChatType: isDirectMessage ? "direct" : "channel",
        ConversationLabel: envelopeFrom,
        SenderName: senderName,
        SenderId: senderId,
        SenderUsername: senderId.split(":")[0]?.replace(/^@/, ""),
        GroupSubject: isRoom ? (roomName ?? roomId) : undefined,
        GroupChannel: isRoom ? (room.getCanonicalAlias?.() ?? roomId) : undefined,
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
	      });

      const storePath = resolveStorePath(cfg.session?.store, {
        agentId: route.agentId,
      });
      void recordSessionMetaFromInbound({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
      }).catch((err) => {
        logger.warn(
          { error: String(err), storePath, sessionKey: ctxPayload.SessionKey ?? route.sessionKey },
          "failed updating session meta",
        );
      });

      if (isDirectMessage) {
        await updateLastRoute({
          storePath,
          sessionKey: route.mainSessionKey,
          channel: "matrix",
          to: `room:${roomId}`,
          accountId: route.accountId,
          ctx: ctxPayload,
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
