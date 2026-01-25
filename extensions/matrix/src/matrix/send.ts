import type { MatrixClient } from "matrix-bot-sdk";

import type { PollInput } from "clawdbot/plugin-sdk";
import { getMatrixRuntime } from "../runtime.js";
import { buildPollStartContent, M_POLL_START } from "./poll-types.js";
import { resolveMatrixClient, resolveMediaMaxBytes } from "./send/client.js";
import {
  buildReplyRelation,
  buildTextContent,
  buildThreadRelation,
  resolveMatrixMsgType,
  resolveMatrixVoiceDecision,
} from "./send/formatting.js";
import {
  buildMediaContent,
  prepareImageInfo,
  resolveMediaDurationMs,
  uploadMediaMaybeEncrypted,
} from "./send/media.js";
import { normalizeThreadId, resolveMatrixRoomId } from "./send/targets.js";
import {
  EventType,
  MsgType,
  RelationType,
  type MatrixOutboundContent,
  type MatrixSendOpts,
  type MatrixSendResult,
  type ReactionEventContent,
} from "./send/types.js";

const MATRIX_TEXT_LIMIT = 4000;
const getCore = () => getMatrixRuntime();

export type { MatrixSendOpts, MatrixSendResult } from "./send/types.js";
export { resolveMatrixRoomId } from "./send/targets.js";

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
    const cfg = getCore().config.loadConfig();
    const tableMode = getCore().channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "matrix",
      accountId: opts.accountId,
    });
    const convertedMessage = getCore().channel.text.convertMarkdownTables(
      trimmedMessage,
      tableMode,
    );
    const textLimit = getCore().channel.text.resolveTextChunkLimit(cfg, "matrix");
    const chunkLimit = Math.min(textLimit, MATRIX_TEXT_LIMIT);
    const chunkMode = getCore().channel.text.resolveChunkMode(cfg, "matrix", opts.accountId);
    const chunks = getCore().channel.text.chunkMarkdownTextWithMode(
      convertedMessage,
      chunkLimit,
      chunkMode,
    );
    const threadId = normalizeThreadId(opts.threadId);
    const relation = threadId
      ? buildThreadRelation(threadId, opts.replyToId)
      : buildReplyRelation(opts.replyToId);
    const sendContent = async (content: MatrixOutboundContent) => {
      // matrix-bot-sdk uses sendMessage differently
      const eventId = await client.sendMessage(roomId, content);
      return eventId;
    };

    let lastMessageId = "";
    if (opts.mediaUrl) {
      const maxBytes = resolveMediaMaxBytes();
      const media = await getCore().media.loadWebMedia(opts.mediaUrl, maxBytes);
      const uploaded = await uploadMediaMaybeEncrypted(client, roomId, media.buffer, {
        contentType: media.contentType,
        filename: media.fileName,
      });
      const durationMs = await resolveMediaDurationMs({
        buffer: media.buffer,
        contentType: media.contentType,
        fileName: media.fileName,
        kind: media.kind,
      });
      const baseMsgType = resolveMatrixMsgType(media.contentType, media.fileName);
      const { useVoice } = resolveMatrixVoiceDecision({
        wantsVoice: opts.audioAsVoice === true,
        contentType: media.contentType,
        fileName: media.fileName,
      });
      const msgtype = useVoice ? MsgType.Audio : baseMsgType;
      const isImage = msgtype === MsgType.Image;
      const imageInfo = isImage
        ? await prepareImageInfo({ buffer: media.buffer, client })
        : undefined;
      const [firstChunk, ...rest] = chunks;
      const body = useVoice ? "Voice message" : (firstChunk ?? media.fileName ?? "(file)");
      const content = buildMediaContent({
        msgtype,
        body,
        url: uploaded.url,
        file: uploaded.file,
        filename: media.fileName,
        mimetype: media.contentType,
        size: media.buffer.byteLength,
        durationMs,
        relation,
        isVoice: useVoice,
        imageInfo,
      });
      const eventId = await sendContent(content);
      lastMessageId = eventId ?? lastMessageId;
      const textChunks = useVoice ? chunks : rest;
      const followupRelation = threadId ? relation : undefined;
      for (const chunk of textChunks) {
        const text = chunk.trim();
        if (!text) continue;
        const followup = buildTextContent(text, followupRelation);
        const followupEventId = await sendContent(followup);
        lastMessageId = followupEventId ?? lastMessageId;
      }
    } else {
      for (const chunk of chunks.length ? chunks : [""]) {
        const text = chunk.trim();
        if (!text) continue;
        const content = buildTextContent(text, relation);
        const eventId = await sendContent(content);
        lastMessageId = eventId ?? lastMessageId;
      }
    }

    return {
      messageId: lastMessageId || "unknown",
      roomId,
    };
  } finally {
    if (stopOnDone) {
      client.stop();
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
    const pollPayload = threadId
      ? { ...pollContent, "m.relates_to": buildThreadRelation(threadId) }
      : pollContent;
    // matrix-bot-sdk sendEvent returns eventId string directly
    const eventId = await client.sendEvent(roomId, M_POLL_START, pollPayload);

    return {
      eventId: eventId ?? "unknown",
      roomId,
    };
  } finally {
    if (stopOnDone) {
      client.stop();
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
    await resolved.setTyping(roomId, typing, resolvedTimeoutMs);
  } finally {
    if (stopOnDone) {
      resolved.stop();
    }
  }
}

export async function sendReadReceiptMatrix(
  roomId: string,
  eventId: string,
  client?: MatrixClient,
): Promise<void> {
  if (!eventId?.trim()) return;
  const { client: resolved, stopOnDone } = await resolveMatrixClient({
    client,
  });
  try {
    const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
    await resolved.sendReadReceipt(resolvedRoom, eventId.trim());
  } finally {
    if (stopOnDone) {
      resolved.stop();
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
      resolved.stop();
    }
  }
}
