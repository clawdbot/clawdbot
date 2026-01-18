import type { AccountDataEvents, MatrixClient } from "matrix-js-sdk";
import { EventType, MsgType, RelationType } from "matrix-js-sdk";
import type {
  RoomMessageEventContent,
  ReactionEventContent,
} from "matrix-js-sdk/lib/@types/events.js";

import {
  chunkMarkdownText,
  getImageMetadata,
  isVoiceCompatibleAudio,
  loadConfig,
  loadWebMedia,
  mediaKindFromMime,
  type PollInput,
  resolveTextChunkLimit,
  resizeToJpeg,
} from "clawdbot/plugin-sdk";
import { getActiveMatrixClient } from "./active-client.js";
import {
  createMatrixClient,
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
  waitForMatrixSync,
} from "./client.js";
import { markdownToMatrixHtml } from "./format.js";
import { buildPollStartContent, M_POLL_START } from "./poll-types.js";
import type { CoreConfig } from "../types.js";

const MATRIX_TEXT_LIMIT = 4000;

type MatrixDirectAccountData = AccountDataEvents[EventType.Direct];

type MatrixReplyRelation = {
  "m.in_reply_to": { event_id: string };
};

type MatrixMessageContent = Record<string, unknown> & {
  msgtype: MsgType;
  body: string;
};

type MatrixUploadContent = Parameters<MatrixClient["uploadContent"]>[0];

export type MatrixSendResult = {
  messageId: string;
  roomId: string;
};

export type MatrixSendOpts = {
  client?: MatrixClient;
  mediaUrl?: string;
  replyToId?: string;
  threadId?: string | number | null;
  timeoutMs?: number;
  /** Send audio as voice message (voice bubble) instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
};

function ensureNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}

function resolveMediaMaxBytes(): number | undefined {
  const cfg = loadConfig() as CoreConfig;
  if (typeof cfg.channels?.matrix?.mediaMaxMb === "number") {
    return cfg.channels.matrix.mediaMaxMb * 1024 * 1024;
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

function normalizeThreadId(raw?: string | number | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : null;
}

async function resolveDirectRoomId(client: MatrixClient, userId: string): Promise<string> {
  const trimmed = userId.trim();
  if (!trimmed.startsWith("@")) {
    throw new Error(`Matrix user IDs must be fully qualified (got "${trimmed}")`);
  }
  const directEvent = client.getAccountData(EventType.Direct);
  const directContent = directEvent?.getContent<MatrixDirectAccountData>();
  const list = Array.isArray(directContent?.[trimmed]) ? directContent[trimmed] : [];
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

type MatrixImageInfo = {
  w?: number;
  h?: number;
  thumbnail_url?: string;
  thumbnail_info?: {
    w: number;
    h: number;
    mimetype: string;
    size: number;
  };
};

function buildMediaContent(params: {
  msgtype: MsgType.Image | MsgType.Audio | MsgType.Video | MsgType.File;
  body: string;
  url: string;
  filename?: string;
  mimetype?: string;
  size: number;
  relation?: MatrixReplyRelation;
  isVoice?: boolean;
  durationMs?: number;
  imageInfo?: MatrixImageInfo;
}): RoomMessageEventContent {
  const info: Record<string, unknown> = { mimetype: params.mimetype, size: params.size };
  if (params.durationMs !== undefined) {
    info.duration = params.durationMs;
  }
  if (params.imageInfo) {
    if (params.imageInfo.w) info.w = params.imageInfo.w;
    if (params.imageInfo.h) info.h = params.imageInfo.h;
    if (params.imageInfo.thumbnail_url) {
      info.thumbnail_url = params.imageInfo.thumbnail_url;
      if (params.imageInfo.thumbnail_info) {
        info.thumbnail_info = params.imageInfo.thumbnail_info;
      }
    }
  }
  const base: MatrixMessageContent = {
    msgtype: params.msgtype,
    body: params.body,
    filename: params.filename,
    info,
    url: params.url,
  };
  if (params.isVoice) {
    base["org.matrix.msc3245.voice"] = {};
    base["org.matrix.msc1767.audio"] = {
      duration: params.durationMs,
    };
  }
  if (params.relation) {
    base["m.relates_to"] = params.relation;
  }
  applyMatrixFormatting(base, params.body);
  return base as RoomMessageEventContent;
}

function buildTextContent(body: string, relation?: MatrixReplyRelation): RoomMessageEventContent {
  const content: MatrixMessageContent = relation
    ? {
        msgtype: MsgType.Text,
        body,
        "m.relates_to": relation,
      }
    : {
        msgtype: MsgType.Text,
        body,
      };
  applyMatrixFormatting(content, body);
  return content as RoomMessageEventContent;
}

function applyMatrixFormatting(content: MatrixMessageContent, body: string): void {
  const formatted = markdownToMatrixHtml(body ?? "");
  if (!formatted) return;
  content.format = "org.matrix.custom.html";
  content.formatted_body = formatted;
}

function buildReplyRelation(replyToId?: string): MatrixReplyRelation | undefined {
  const trimmed = replyToId?.trim();
  if (!trimmed) return undefined;
  return { "m.in_reply_to": { event_id: trimmed } };
}

function resolveMatrixMsgType(
  contentType?: string,
  fileName?: string,
): MsgType.Image | MsgType.Audio | MsgType.Video | MsgType.File {
  const kind = mediaKindFromMime(contentType ?? "");
  switch (kind) {
    case "image":
      return MsgType.Image;
    case "audio":
      return MsgType.Audio;
    case "video":
      return MsgType.Video;
    default:
      return MsgType.File;
  }
}

function resolveMatrixVoiceDecision(opts: {
  wantsVoice: boolean;
  contentType?: string;
  fileName?: string;
}): { useVoice: boolean } {
  if (!opts.wantsVoice) return { useVoice: false };
  if (isVoiceCompatibleAudio({ contentType: opts.contentType, fileName: opts.fileName })) {
    return { useVoice: true };
  }
  return { useVoice: false };
}

const THUMBNAIL_MAX_SIDE = 800;
const THUMBNAIL_QUALITY = 80;

async function prepareImageInfo(params: {
  buffer: Buffer;
  client: MatrixClient;
}): Promise<MatrixImageInfo | undefined> {
  const meta = await getImageMetadata(params.buffer).catch(() => null);
  if (!meta) return undefined;
  const imageInfo: MatrixImageInfo = { w: meta.width, h: meta.height };
  const maxDim = Math.max(meta.width, meta.height);
  if (maxDim > THUMBNAIL_MAX_SIDE) {
    try {
      const thumbBuffer = await resizeToJpeg({
        buffer: params.buffer,
        maxSide: THUMBNAIL_MAX_SIDE,
        quality: THUMBNAIL_QUALITY,
        withoutEnlargement: true,
      });
      const thumbMeta = await getImageMetadata(thumbBuffer).catch(() => null);
      const thumbUri = await params.client.uploadContent(thumbBuffer as MatrixUploadContent, {
        type: "image/jpeg",
        name: "thumbnail.jpg",
      });
      imageInfo.thumbnail_url = thumbUri.content_uri;
      if (thumbMeta) {
        imageInfo.thumbnail_info = {
          w: thumbMeta.width,
          h: thumbMeta.height,
          mimetype: "image/jpeg",
          size: thumbBuffer.byteLength,
        };
      }
    } catch {
      // Thumbnail generation failed, continue without it
    }
  }
  return imageInfo;
}

async function uploadFile(
  client: MatrixClient,
  file: MatrixUploadContent | Buffer,
  params: {
    contentType?: string;
    filename?: string;
    includeFilename?: boolean;
  },
): Promise<string> {
  const upload = await client.uploadContent(file as MatrixUploadContent, {
    type: params.contentType,
    name: params.filename,
    includeFilename: params.includeFilename,
  });
  return upload.content_uri;
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
    localTimeoutMs: opts.timeoutMs,
  });
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
    const cfg = loadConfig();
    const textLimit = resolveTextChunkLimit(cfg, "matrix");
    const chunkLimit = Math.min(textLimit, MATRIX_TEXT_LIMIT);
    const chunks = chunkMarkdownText(trimmedMessage, chunkLimit);
    const threadId = normalizeThreadId(opts.threadId);
    const relation = threadId ? undefined : buildReplyRelation(opts.replyToId);
    const sendContent = (content: RoomMessageEventContent) =>
      threadId ? client.sendMessage(roomId, threadId, content) : client.sendMessage(roomId, content);

    let lastMessageId = "";
    if (opts.mediaUrl) {
      const maxBytes = resolveMediaMaxBytes();
      const media = await loadWebMedia(opts.mediaUrl, maxBytes);
      const contentUri = await uploadFile(client, media.buffer, {
        contentType: media.contentType,
        filename: media.fileName,
      });
      const baseMsgType = resolveMatrixMsgType(media.contentType, media.fileName);
      const { useVoice } = resolveMatrixVoiceDecision({
        wantsVoice: opts.audioAsVoice === true,
        contentType: media.contentType,
        fileName: media.fileName,
      });
      const msgtype = useVoice ? MsgType.Audio : baseMsgType;
      const isImage = msgtype === MsgType.Image;
      const imageInfo = isImage ? await prepareImageInfo({ buffer: media.buffer, client }) : undefined;
      const [firstChunk, ...rest] = chunks;
      const body = useVoice ? "Voice message" : (firstChunk ?? media.fileName ?? "(file)");
      const content = buildMediaContent({
        msgtype,
        body,
        url: contentUri,
        filename: media.fileName,
        mimetype: media.contentType,
        size: media.buffer.byteLength,
        relation,
        isVoice: useVoice,
        imageInfo,
      });
      const response = await sendContent(content);
      lastMessageId = response.event_id ?? lastMessageId;
      const textChunks = useVoice ? chunks : rest;
      for (const chunk of textChunks) {
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

export async function sendPollMatrix(
  to: string,
  poll: PollInput,
  opts: MatrixSendOpts = {},
): Promise<{ eventId: string; roomId: string }> {
  if (!poll.question?.trim()) {
    throw new Error("Matrix poll requires a question");
  }
  if (!poll.options?.length) {
    throw new Error("Matrix poll requires options");
  }
  const { client, stopOnDone } = await resolveMatrixClient({
    client: opts.client,
    timeoutMs: opts.timeoutMs,
  });

  try {
    const roomId = await resolveMatrixRoomId(client, to);
    const pollContent = buildPollStartContent(poll);
    const threadId = normalizeThreadId(opts.threadId);
    const response = threadId
      ? await client.sendEvent(
          roomId,
          threadId,
          M_POLL_START,
          pollContent,
        )
      : await client.sendEvent(
          roomId,
          M_POLL_START,
          pollContent,
        );

    return {
      eventId: response.event_id ?? "unknown",
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
    const resolvedTimeoutMs = typeof timeoutMs === "number" ? timeoutMs : 30_000;
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
