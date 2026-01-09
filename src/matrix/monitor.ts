import type {
  AccountDataEvents,
  MatrixClient,
  MatrixEvent,
  Room,
  RoomMember,
} from "matrix-js-sdk";
import {
  ClientEvent,
  EventType,
  RelationType,
  RoomEvent,
  RoomMemberEvent,
} from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events.js";
import type { EncryptedFile } from "matrix-js-sdk/lib/@types/media.js";

import {
  chunkMarkdownText,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../auto-reply/commands-registry.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
} from "../auto-reply/reply/mentions.js";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ClawdbotConfig, ReplyToMode } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import type { MatrixRoomConfig } from "../config/types.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { saveMediaBuffer } from "../media/store.js";
import {
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RuntimeEnv } from "../runtime.js";
import { setActiveMatrixClient } from "./active-client.js";
import {
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
} from "./client.js";
import { decryptMatrixAttachment } from "./crypto-attachments.js";
import {
  formatPollAsText,
  isPollStartType,
  type PollStartContent,
  parsePollStartContent,
} from "./poll-types.js";
import {
  reactMatrixMessage,
  sendMessageMatrix,
  sendTypingMatrix,
} from "./send.js";

export type MonitorMatrixOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  initialSyncLimit?: number;
  replyToMode?: ReplyToMode;
};

type MatrixRoomConfigResolved = {
  allowed: boolean;
  allowlistConfigured: boolean;
  config?: MatrixRoomConfig;
};

type MatrixDirectAccountData = AccountDataEvents[EventType.Direct];

const DEFAULT_MEDIA_MAX_MB = 20;

function normalizeAllowList(list?: Array<string | number>) {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

function normalizeAllowListLower(list?: Array<string | number>) {
  return normalizeAllowList(list).map((entry) => entry.toLowerCase());
}

function normalizeMatrixUser(raw?: string | null): string {
  return (raw ?? "").trim().toLowerCase();
}

function resolveMatrixAllowListMatches(params: {
  allowList: string[];
  userId?: string;
  userName?: string;
}) {
  const allowList = params.allowList;
  if (allowList.length === 0) return false;
  if (allowList.includes("*")) return true;
  const userId = normalizeMatrixUser(params.userId);
  const userName = normalizeMatrixUser(params.userName);
  const localPart = userId.startsWith("@")
    ? (userId.slice(1).split(":")[0] ?? "")
    : "";
  const candidates = [
    userId,
    userId ? `matrix:${userId}` : "",
    userId ? `user:${userId}` : "",
    userName,
    localPart,
  ].filter(Boolean);
  return candidates.some((value) => allowList.includes(value));
}

function resolveMatrixRoomConfig(params: {
  rooms?: NonNullable<ClawdbotConfig["matrix"]>["rooms"];
  roomId: string;
  aliases: string[];
  name?: string | null;
}): MatrixRoomConfigResolved {
  const rooms = params.rooms ?? {};
  const keys = Object.keys(rooms);
  const allowlistConfigured = keys.length > 0;
  const candidates = [
    params.roomId,
    `room:${params.roomId}`,
    ...params.aliases,
    params.name ?? "",
  ].filter(Boolean);
  let matched: MatrixRoomConfigResolved["config"] | undefined;
  for (const candidate of candidates) {
    if (rooms[candidate]) {
      matched = rooms[candidate];
      break;
    }
  }
  if (!matched && rooms["*"]) {
    matched = rooms["*"];
  }
  const allowed = matched
    ? matched.enabled !== false && matched.allow !== false
    : false;
  return { allowed, allowlistConfigured, config: matched };
}

function isLikelyDirectRoom(params: {
  room: Room;
  senderId: string;
  selfId?: string | null;
}): boolean {
  if (!params.selfId) return false;
  const memberCount = params.room.getJoinedMemberCount?.();
  if (typeof memberCount !== "number" || memberCount !== 2) return false;
  const senderMember = params.room.getMember(params.senderId);
  const selfMember = params.room.getMember(params.selfId);
  return Boolean(senderMember && selfMember);
}

function hasDirectFlag(member?: RoomMember | null): boolean {
  if (!member?.events.member) return false;
  const content = member.events.member.getContent() as
    | { is_direct?: boolean }
    | undefined;
  if (content?.is_direct === true) return true;
  const prev = member.events.member.getPrevContent() as
    | { is_direct?: boolean }
    | undefined;
  return prev?.is_direct === true;
}

function isDirectRoomByFlag(params: {
  room: Room;
  senderId: string;
  selfId?: string | null;
}): boolean {
  if (!params.selfId) return false;
  const selfMember = params.room.getMember(params.selfId);
  const senderMember = params.room.getMember(params.senderId);
  if (hasDirectFlag(selfMember) || hasDirectFlag(senderMember)) return true;
  const inviter = selfMember?.getDMInviter() ?? senderMember?.getDMInviter();
  return Boolean(inviter);
}

function resolveMatrixThreadTarget(params: {
  threadReplies: "off" | "inbound" | "always";
  messageId: string;
  threadRootId?: string;
  isThreadRoot?: boolean;
}): string | undefined {
  const { threadReplies, messageId, threadRootId } = params;
  if (threadReplies === "off") return undefined;
  const isThreadRoot = params.isThreadRoot === true;
  const hasInboundThread = Boolean(
    threadRootId && threadRootId !== messageId && !isThreadRoot,
  );
  if (threadReplies === "inbound") {
    return hasInboundThread ? threadRootId : undefined;
  }
  if (threadReplies === "always") {
    return threadRootId ?? messageId;
  }
  return undefined;
}

function resolveMatrixThreadRootId(params: {
  event: MatrixEvent;
  content: RoomMessageEventContent;
}): string | undefined {
  const fromThread = params.event.getThread?.()?.id;
  if (fromThread) return fromThread;
  const direct = params.event.threadRootId ?? undefined;
  if (direct) return direct;
  const relates = params.content["m.relates_to"];
  if (!relates || typeof relates !== "object") return undefined;
  if ("rel_type" in relates && relates.rel_type === RelationType.Thread) {
    if ("event_id" in relates && typeof relates.event_id === "string") {
      return relates.event_id;
    }
    if (
      "m.in_reply_to" in relates &&
      typeof relates["m.in_reply_to"] === "object" &&
      relates["m.in_reply_to"] &&
      "event_id" in relates["m.in_reply_to"] &&
      typeof relates["m.in_reply_to"].event_id === "string"
    ) {
      return relates["m.in_reply_to"].event_id;
    }
  }
  return undefined;
}

function resolveMentions(params: {
  content: RoomMessageEventContent;
  userId?: string | null;
  text?: string;
  mentionRegexes: RegExp[];
}) {
  const mentions = params.content["m.mentions"];
  const mentionedUsers = Array.isArray(mentions?.user_ids)
    ? new Set(mentions.user_ids)
    : new Set<string>();
  const wasMentioned =
    Boolean(mentions?.room) ||
    (params.userId ? mentionedUsers.has(params.userId) : false) ||
    matchesMentionPatterns(params.text ?? "", params.mentionRegexes);
  return { wasMentioned, hasExplicitMention: Boolean(mentions) };
}

async function downloadMatrixMedia(params: {
  client: MatrixClient;
  mxcUrl: string;
  contentType?: string;
  maxBytes: number;
}): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
} | null> {
  const fetched = await fetchMatrixMediaBuffer({
    client: params.client,
    mxcUrl: params.mxcUrl,
    maxBytes: params.maxBytes,
  });
  if (!fetched) return null;
  const headerType = fetched.headerType ?? params.contentType ?? undefined;
  const saved = await saveMediaBuffer(
    fetched.buffer,
    headerType,
    "inbound",
    params.maxBytes,
  );
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: "[matrix media]",
  };
}

async function fetchMatrixMediaBuffer(params: {
  client: MatrixClient;
  mxcUrl: string;
  maxBytes: number;
}): Promise<{ buffer: Buffer; headerType?: string } | null> {
  const url = params.client.mxcUrlToHttp(
    params.mxcUrl,
    undefined,
    undefined,
    undefined,
    false,
    true,
    true,
  );
  if (!url) return null;
  const token = params.client.getAccessToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`Matrix media download failed: HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > params.maxBytes) {
    throw new Error("Matrix media exceeds configured size limit");
  }
  const headerType = res.headers.get("content-type") ?? undefined;
  return { buffer, headerType };
}

function resolveEncryptedFile(
  content: RoomMessageEventContent,
): EncryptedFile | null {
  if (!("file" in content)) return null;
  const file = content.file as unknown;
  if (!file || typeof file !== "object") return null;
  const value = file as Record<string, unknown>;
  if (typeof value.url !== "string") return null;
  if (typeof value.iv !== "string") return null;
  if (typeof value.v !== "string") return null;
  if (typeof value.key !== "object" || value.key === null) return null;
  if (typeof value.hashes !== "object" || value.hashes === null) return null;
  return file as EncryptedFile;
}

async function deliverMatrixReplies(params: {
  replies: ReplyPayload[];
  roomId: string;
  client: MatrixClient;
  runtime: RuntimeEnv;
  textLimit: number;
  replyToMode: ReplyToMode;
  threadId?: string;
}): Promise<void> {
  const chunkLimit = Math.min(params.textLimit, 4000);
  let hasReplied = false;
  for (const reply of params.replies) {
    if (!reply?.text && !reply?.mediaUrl && !(reply?.mediaUrls?.length ?? 0)) {
      params.runtime.error?.(danger("matrix reply missing text/media"));
      continue;
    }
    const replyToIdRaw = reply.replyToId?.trim();
    const replyToId =
      params.threadId || params.replyToMode === "off"
        ? undefined
        : replyToIdRaw;
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];

    const shouldIncludeReply = (id?: string) =>
      Boolean(id) && (params.replyToMode === "all" || !hasReplied);

    if (mediaList.length === 0) {
      for (const chunk of chunkMarkdownText(reply.text ?? "", chunkLimit)) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        await sendMessageMatrix(params.roomId, trimmed, {
          client: params.client,
          replyToId: shouldIncludeReply(replyToId) ? replyToId : undefined,
          threadId: params.threadId,
        });
        if (shouldIncludeReply(replyToId)) {
          hasReplied = true;
        }
      }
      continue;
    }

    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? (reply.text ?? "") : "";
      await sendMessageMatrix(params.roomId, caption, {
        client: params.client,
        mediaUrl,
        replyToId: shouldIncludeReply(replyToId) ? replyToId : undefined,
        threadId: params.threadId,
      });
      if (shouldIncludeReply(replyToId)) {
        hasReplied = true;
      }
      first = false;
    }
  }
}

export async function monitorMatrixProvider(
  opts: MonitorMatrixOpts = {},
): Promise<void> {
  if (isBunRuntime()) {
    throw new Error(
      "Matrix provider requires Node (bun runtime not supported)",
    );
  }
  const cfg = loadConfig();
  if (cfg.matrix?.enabled === false) return;

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const auth = await resolveMatrixAuth({ cfg });
  const client = await resolveSharedMatrixClient({
    cfg,
    auth,
    startClient: false,
  });
  setActiveMatrixClient(client);

  const mentionRegexes = buildMentionRegexes(cfg);
  const logger = getChildLogger({ module: "matrix-auto-reply" });
  const allowlistOnly = cfg.matrix?.allowlistOnly === true;
  const groupPolicyRaw = cfg.matrix?.groupPolicy ?? "disabled";
  const groupPolicy =
    allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
  const replyToMode = opts.replyToMode ?? cfg.matrix?.replyToMode ?? "off";
  const threadReplies = cfg.matrix?.threadReplies ?? "inbound";
  const dmConfig = cfg.matrix?.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicyRaw = dmConfig?.policy ?? "pairing";
  const dmPolicy =
    allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const allowFrom = dmConfig?.allowFrom ?? [];
  const textLimit = resolveTextChunkLimit(cfg, "matrix");
  const mediaMaxMb =
    opts.mediaMaxMb ?? cfg.matrix?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  // Avoid replaying backlog messages when the client first syncs.
  const startupMs = Date.now();
  const startupGraceMs = 0;

  const directMap = new Map<string, Set<string>>();
  const updateDirectMap = (content: MatrixDirectAccountData) => {
    directMap.clear();
    for (const [userId, rooms] of Object.entries(content)) {
      if (!Array.isArray(rooms)) continue;
      const ids = rooms.map((roomId) => String(roomId).trim()).filter(Boolean);
      if (ids.length === 0) continue;
      directMap.set(userId, new Set(ids));
    }
  };

  const initialDirect = client.getAccountData(EventType.Direct);
  if (initialDirect) {
    updateDirectMap(initialDirect.getContent<MatrixDirectAccountData>() ?? {});
  }

  client.on(ClientEvent.AccountData, (event: MatrixEvent) => {
    if (event.getType() !== EventType.Direct) return;
    updateDirectMap(event.getContent<MatrixDirectAccountData>() ?? {});
  });

  const autoJoin = cfg.matrix?.autoJoin ?? "always";
  const autoJoinAllowlist = cfg.matrix?.autoJoinAllowlist ?? [];
  client.on(
    RoomMemberEvent.Membership,
    async (_event: MatrixEvent, member: RoomMember) => {
      if (member.userId !== client.getUserId()) return;
      if (member.membership !== "invite") return;
      const roomId = member.roomId;
      if (autoJoin === "off") return;
      if (autoJoin === "allowlist") {
        const invitedRoom = client.getRoom(roomId);
        const alias = invitedRoom?.getCanonicalAlias?.() ?? "";
        const altAliases = invitedRoom?.getAltAliases?.() ?? [];
        const allowed =
          autoJoinAllowlist.includes("*") ||
          autoJoinAllowlist.includes(roomId) ||
          (alias ? autoJoinAllowlist.includes(alias) : false) ||
          altAliases.some((value) => autoJoinAllowlist.includes(value));
        if (!allowed) {
          logVerbose(
            `matrix: invite ignored (not in allowlist) room=${roomId}`,
          );
          return;
        }
      }
      try {
        await client.joinRoom(roomId);
        logVerbose(`matrix: joined room ${roomId}`);
      } catch (err) {
        runtime.error?.(
          danger(`matrix: failed to join room ${roomId}: ${String(err)}`),
        );
      }
    },
  );

  const handleTimeline = async (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline?: boolean,
  ) => {
    try {
      if (!room) return;
      if (toStartOfTimeline) return;
      // Handle both regular messages and poll events
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

      // For poll events, parse the poll content and convert to text
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
          // Create synthetic content for downstream processing
          content = {
            msgtype: "m.text",
            body: pollText,
          } as unknown as RoomMessageEventContent;
        } else {
          // Couldn't parse poll, skip
          return;
        }
      }

      const relates = content["m.relates_to"];
      if (relates && "rel_type" in relates) {
        if (relates.rel_type === RelationType.Replace) return;
      }

      const roomId = room.roomId;
      const directRooms = directMap.get(senderId);
      const selfId = client.getUserId();
      const isDirectByFlag = isDirectRoomByFlag({ room, senderId, selfId });
      const isDirectMessage =
        Boolean(directRooms?.has(roomId)) ||
        isDirectByFlag ||
        isLikelyDirectRoom({ room, senderId, selfId });
      const isRoom = !isDirectMessage;

      if (!isDirectMessage && groupPolicy === "disabled") return;

      const roomAliases = [
        room.getCanonicalAlias?.() ?? "",
        ...(room.getAltAliases?.() ?? []),
      ].filter(Boolean);
      const roomName = room.name ?? undefined;
      const roomConfigInfo = resolveMatrixRoomConfig({
        rooms: cfg.matrix?.rooms,
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
      const storeAllowFrom = await readProviderAllowFromStore("matrix").catch(
        () => [],
      );
      const effectiveAllowFrom = normalizeAllowListLower([
        ...allowFrom,
        ...storeAllowFrom,
      ]);

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
              const { code, created } = await upsertProviderPairingRequest({
                provider: "matrix",
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
                      "clawdbot pairing approve --provider matrix <code>",
                    ].join("\n"),
                    { client },
                  );
                } catch (err) {
                  logVerbose(
                    `matrix pairing reply failed for ${senderId}: ${String(
                      err,
                    )}`,
                  );
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
          logVerbose(
            `matrix: blocked sender ${senderId} (room users allowlist)`,
          );
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
        "url" in content && typeof content.url === "string"
          ? content.url
          : undefined;
      const encryptedFile = resolveEncryptedFile(content);
      if (!rawBody && !contentUrl && !encryptedFile) {
        return;
      }

      const contentType =
        "info" in content && content.info && "mimetype" in content.info
          ? content.info.mimetype
          : undefined;
      if (encryptedFile) {
        if (encryptedFile.url.startsWith("mxc://")) {
          try {
            const fetched = await fetchMatrixMediaBuffer({
              client,
              mxcUrl: encryptedFile.url,
              maxBytes: mediaMaxBytes,
            });
            if (fetched) {
              const decrypted = await decryptMatrixAttachment({
                encrypted: fetched.buffer,
                file: encryptedFile,
              });
              const saved = await saveMediaBuffer(
                Buffer.from(decrypted),
                contentType,
                "inbound",
                mediaMaxBytes,
              );
              media = {
                path: saved.path,
                contentType: saved.contentType,
                placeholder: "[matrix media]",
              };
            }
          } catch (err) {
            logVerbose(
              `matrix: encrypted media download failed: ${String(err)}`,
            );
          }
        }
      } else if (contentUrl?.startsWith("mxc://")) {
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
      if (
        isRoom &&
        shouldRequireMention &&
        !wasMentioned &&
        !shouldBypassMention
      ) {
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
        provider: "Matrix",
        from: senderName,
        timestamp: event.getTs() ?? undefined,
        body: textWithId,
      });

      const route = resolveAgentRoute({
        cfg,
        provider: "matrix",
        peer: {
          kind: isDirectMessage ? "dm" : "channel",
          id: isDirectMessage ? senderId : roomId,
        },
      });

      const groupSystemPrompt =
        roomConfigInfo.config?.systemPrompt?.trim() || undefined;
      const ctxPayload = {
        Body: body,
        From: isDirectMessage
          ? `matrix:${senderId}`
          : `matrix:channel:${roomId}`,
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
          provider: "matrix",
          to: `room:${roomId}`,
          accountId: route.accountId,
        });
      }

      if (shouldLogVerbose()) {
        const preview = bodyText.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `matrix inbound: room=${roomId} from=${senderId} preview="${preview}"`,
        );
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
        reactMatrixMessage(roomId, messageId, ackReaction, client).catch(
          (err) => {
            logVerbose(
              `matrix react failed for room ${roomId}: ${String(err)}`,
            );
          },
        );
      }

      const replyTarget = ctxPayload.To;
      if (!replyTarget) {
        runtime.error?.(danger("matrix: missing reply target"));
        return;
      }

      let didSendReply = false;
      const { dispatcher, replyOptions, markDispatchIdle } =
        createReplyDispatcherWithTyping({
          responsePrefix: cfg.messages?.responsePrefix,
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
            runtime.error?.(
              danger(`matrix ${info.kind} reply failed: ${String(err)}`),
            );
          },
          onReplyStart: () =>
            sendTypingMatrix(roomId, true, undefined, client).catch(() => {}),
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
        logVerbose(
          `matrix: delivered ${finalCount} reply${
            finalCount === 1 ? "" : "ies"
          } to ${replyTarget}`,
        );
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

  await resolveSharedMatrixClient({ cfg, auth, startClient: true });
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
