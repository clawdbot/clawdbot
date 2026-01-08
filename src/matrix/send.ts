import type { AccountDataEvents, MatrixClient } from "matrix-js-sdk";
import { EventType, MsgType, RelationType } from "matrix-js-sdk";
import type {
  ReactionEventContent,
  RoomMessageEventContent,
} from "matrix-js-sdk/lib/@types/events.js";

import {
  chunkMarkdownText,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
import { loadConfig } from "../config/config.js";
import { loadWebMedia } from "../web/media.js";
import { getActiveMatrixClient } from "./active-client.js";
import {
  createMatrixClient,
  ensureMatrixCrypto,
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
  waitForMatrixSync,
} from "./client.js";

const MATRIX_TEXT_LIMIT = 4000;

type MatrixDirectAccountData = AccountDataEvents[EventType.Direct];
type MatrixReplyRelation = {
  "m.in_reply_to": { event_id: string };
};

export type MatrixSendResult = {
  messageId: string;
  roomId: string;
};

export type MatrixSendOpts = {
  client?: MatrixClient;
  mediaUrl?: string;
  replyToId?: string;
  threadId?: string | null;
  timeoutMs?: number;
};

function ensureNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}

function resolveMediaMaxBytes(): number | undefined {
  const cfg = loadConfig();
  if (typeof cfg.matrix?.mediaMaxMb === "number") {
    return cfg.matrix.mediaMaxMb * 1024 * 1024;
  }
  return undefined;
}

function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Matrix target is required (room:<id> or #alias)");
  }
  return trimmed;
}

async function resolveDirectRoomId(
  client: MatrixClient,
  userId: string,
): Promise<string> {
  const trimmed = userId.trim();
  if (!trimmed.startsWith("@")) {
    throw new Error(
      `Matrix user IDs must be fully qualified (got "${trimmed}")`,
    );
  }
  const directEvent = client.getAccountData(EventType.Direct);
  const directContent = directEvent?.getContent<MatrixDirectAccountData>();
  const list = Array.isArray(directContent?.[trimmed])
    ? directContent[trimmed]
    : [];
  if (list.length > 0) return list[0];
  const server = await client.getAccountDataFromServer(EventType.Direct);
  const serverList = Array.isArray(server?.[trimmed]) ? server[trimmed] : [];
  if (serverList.length > 0) return serverList[0];
  throw new Error(
    `No m.direct room found for ${trimmed}. Open a DM first so Matrix can set m.direct.`,
  );
}

export async function resolveMatrixRoomId(
  client: MatrixClient,
  raw: string,
): Promise<string> {
  const target = normalizeTarget(raw);
  const lowered = target.toLowerCase();
  if (lowered.startsWith("matrix:")) {
    return await resolveMatrixRoomId(client, target.slice("matrix:".length));
  }
  if (lowered.startsWith("room:")) {
    return await resolveMatrixRoomId(client, target.slice("room:".length));
  }
  if (lowered.startsWith("channel:")) {
    return await resolveMatrixRoomId(client, target.slice("channel:".length));
  }
  if (lowered.startsWith("user:")) {
    return await resolveDirectRoomId(client, target.slice("user:".length));
  }
  if (target.startsWith("@")) {
    return await resolveDirectRoomId(client, target);
  }
  if (target.startsWith("#")) {
    const resolved = await client.getRoomIdForAlias(target);
    if (!resolved?.room_id) {
      throw new Error(`Matrix alias ${target} could not be resolved`);
    }
    return resolved.room_id;
  }
  return target;
}

function resolveMatrixMsgType(
  contentType?: string,
): MsgType.Image | MsgType.Audio | MsgType.Video | MsgType.File {
  if (!contentType) return MsgType.File;
  if (contentType.startsWith("image/")) return MsgType.Image;
  if (contentType.startsWith("audio/")) return MsgType.Audio;
  if (contentType.startsWith("video/")) return MsgType.Video;
  return MsgType.File;
}

function buildMediaContent(params: {
  msgtype: MsgType.Image | MsgType.Audio | MsgType.Video | MsgType.File;
  body: string;
  url: string;
  filename?: string;
  mimetype?: string;
  size: number;
  relation?: MatrixReplyRelation;
}): RoomMessageEventContent {
  const info = { mimetype: params.mimetype, size: params.size };
  const base = {
    body: params.body,
    url: params.url,
    filename: params.filename,
    info,
  };
  if (params.relation) {
    switch (params.msgtype) {
      case MsgType.Image:
        return {
          ...base,
          msgtype: MsgType.Image,
          "m.relates_to": params.relation,
        };
      case MsgType.Audio:
        return {
          ...base,
          msgtype: MsgType.Audio,
          "m.relates_to": params.relation,
        };
      case MsgType.Video:
        return {
          ...base,
          msgtype: MsgType.Video,
          "m.relates_to": params.relation,
        };
      default:
        return {
          ...base,
          msgtype: MsgType.File,
          "m.relates_to": params.relation,
        };
    }
  }
  switch (params.msgtype) {
    case MsgType.Image:
      return { ...base, msgtype: MsgType.Image };
    case MsgType.Audio:
      return { ...base, msgtype: MsgType.Audio };
    case MsgType.Video:
      return { ...base, msgtype: MsgType.Video };
    default:
      return { ...base, msgtype: MsgType.File };
  }
}

function buildTextContent(
  body: string,
  relation?: MatrixReplyRelation,
): RoomMessageEventContent {
  if (relation) {
    return {
      msgtype: MsgType.Text,
      body,
      "m.relates_to": relation,
    };
  }
  return {
    msgtype: MsgType.Text,
    body,
  };
}

async function isMatrixRoomEncrypted(
  client: MatrixClient,
  roomId: string,
): Promise<boolean> {
  const crypto = client.getCrypto();
  if (crypto && "isEncryptionEnabledInRoom" in crypto) {
    try {
      const check = crypto as {
        isEncryptionEnabledInRoom: (id: string) => Promise<boolean>;
      };
      return await check.isEncryptionEnabledInRoom(roomId);
    } catch {
      // fall through to room state check
    }
  }
  const room = client.getRoom(roomId);
  return room?.hasEncryptionStateEvent() ?? false;
}

function buildReplyRelation(
  replyToId?: string,
): MatrixReplyRelation | undefined {
  const trimmed = replyToId?.trim();
  if (!trimmed) return undefined;
  return { "m.in_reply_to": { event_id: trimmed } };
}

async function resolveMatrixClient(opts: {
  client?: MatrixClient;
  timeoutMs?: number;
}): Promise<{ client: MatrixClient; stopOnDone: boolean }> {
  ensureNodeRuntime();
  if (opts.client) return { client: opts.client, stopOnDone: false };
  const active = getActiveMatrixClient();
  if (active) return { client: active, stopOnDone: false };
  const shouldShareClient = Boolean(process.env.CLAWDBOT_GATEWAY_PORT);
  if (shouldShareClient) {
    const client = await resolveSharedMatrixClient({
      timeoutMs: opts.timeoutMs,
    });
    return { client, stopOnDone: false };
  }
  const auth = await resolveMatrixAuth();
  const client = await createMatrixClient({
    homeserver: auth.homeserver,
    userId: auth.userId,
    accessToken: auth.accessToken,
    deviceId: auth.deviceId,
    localTimeoutMs: opts.timeoutMs,
  });
  await ensureMatrixCrypto(client, auth.encryption);
  await client.startClient({
    initialSyncLimit: 0,
    lazyLoadMembers: true,
    threadSupport: true,
  });
  await waitForMatrixSync({ client, timeoutMs: opts.timeoutMs });
  return { client, stopOnDone: true };
}

export async function sendMessageMatrix(
  to: string,
  message: string,
  opts: MatrixSendOpts = {},
): Promise<MatrixSendResult> {
  const trimmedMessage = message?.trim() ?? "";
  if (!trimmedMessage && !opts.mediaUrl) {
    throw new Error("Matrix send requires text or media");
  }
  const { client, stopOnDone } = await resolveMatrixClient({
    client: opts.client,
    timeoutMs: opts.timeoutMs,
  });
  try {
    const roomId = await resolveMatrixRoomId(client, to);
    if (opts.mediaUrl) {
      const encrypted = await isMatrixRoomEncrypted(client, roomId);
      if (encrypted) {
        throw new Error(
          "Matrix encrypted rooms do not support media uploads yet.",
        );
      }
    }
    const cfg = loadConfig();
    const textLimit = resolveTextChunkLimit(cfg, "matrix");
    const chunkLimit = Math.min(textLimit, MATRIX_TEXT_LIMIT);
    const chunks = chunkMarkdownText(trimmedMessage, chunkLimit);
    const threadId = opts.threadId?.trim() || null;
    const relation = threadId ? undefined : buildReplyRelation(opts.replyToId);
    const sendContent = (content: RoomMessageEventContent) =>
      client.sendMessage(roomId, threadId, content);

    let lastMessageId = "";
    if (opts.mediaUrl) {
      const maxBytes = resolveMediaMaxBytes();
      const media = await loadWebMedia(opts.mediaUrl, maxBytes);
      const uploadBody = Uint8Array.from(media.buffer).buffer;
      const upload = await client.uploadContent(uploadBody, {
        type: media.contentType,
        name: media.fileName,
      });
      const msgtype = resolveMatrixMsgType(media.contentType);
      const [firstChunk, ...rest] = chunks;
      const body = firstChunk ?? media.fileName ?? "(file)";
      const content = buildMediaContent({
        msgtype,
        body,
        url: upload.content_uri,
        filename: media.fileName,
        mimetype: media.contentType,
        size: media.buffer.byteLength,
        relation,
      });
      const response = await sendContent(content);
      lastMessageId = response.event_id ?? lastMessageId;
      for (const chunk of rest) {
        const text = chunk.trim();
        if (!text) continue;
        const followup = buildTextContent(text);
        const followupRes = await sendContent(followup);
        lastMessageId = followupRes.event_id ?? lastMessageId;
      }
    } else {
      for (const chunk of chunks.length ? chunks : [""]) {
        const text = chunk.trim();
        if (!text) continue;
        const content = buildTextContent(text, relation);
        const response = await sendContent(content);
        lastMessageId = response.event_id ?? lastMessageId;
      }
    }

    return {
      messageId: lastMessageId || "unknown",
      roomId,
    };
  } finally {
    if (stopOnDone) {
      client.stopClient();
    }
  }
}

export async function sendTypingMatrix(
  roomId: string,
  typing: boolean,
  timeoutMs?: number,
  client?: MatrixClient,
): Promise<void> {
  const { client: resolved, stopOnDone } = await resolveMatrixClient({
    client,
    timeoutMs,
  });
  try {
    const resolvedTimeoutMs =
      typeof timeoutMs === "number" ? timeoutMs : 30_000;
    await resolved.sendTyping(roomId, typing, resolvedTimeoutMs);
  } finally {
    if (stopOnDone) {
      resolved.stopClient();
    }
  }
}

export async function reactMatrixMessage(
  roomId: string,
  messageId: string,
  emoji: string,
  client?: MatrixClient,
): Promise<void> {
  if (!emoji.trim()) {
    throw new Error("Matrix reaction requires an emoji");
  }
  const { client: resolved, stopOnDone } = await resolveMatrixClient({
    client,
  });
  try {
    const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
    const reaction: ReactionEventContent = {
      "m.relates_to": {
        rel_type: RelationType.Annotation,
        event_id: messageId,
        key: emoji,
      },
    };
    await resolved.sendEvent(resolvedRoom, EventType.Reaction, reaction);
  } finally {
    if (stopOnDone) {
      resolved.stopClient();
    }
  }
}
