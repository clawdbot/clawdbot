import type { AccountDataEvents, MatrixClient } from "matrix-js-sdk";
import { EventType, MsgType, RelationType } from "matrix-js-sdk";
import type {
  ReactionEventContent,
  RoomMessageEventContent,
} from "matrix-js-sdk/lib/@types/events.js";

import { chunkMarkdownText, resolveTextChunkLimit } from "../../../../src/auto-reply/chunk.js";
import { loadConfig } from "../../../../src/config/config.js";
import type { PollInput } from "../../../../src/polls.js";
import { loadWebMedia } from "../../../../src/web/media.js";
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
  const base: MatrixMessageContent = {
    msgtype: params.msgtype,
    body: params.body,
    filename: params.filename,
    info,
    url: params.url,
  };
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
    const rawThreadId = opts.threadId;
    const threadId =
      rawThreadId !== undefined && rawThreadId !== null
        ? String(rawThreadId).trim()
        : null;
    const relation = threadId ? undefined : buildReplyRelation(opts.replyToId);
    const sendContent = (content: RoomMessageEventContent) =>
      client.sendMessage(roomId, threadId ?? undefined, content);

    let lastMessageId = "";
    if (opts.mediaUrl) {
      const maxBytes = resolveMediaMaxBytes();
      const media = await loadWebMedia(opts.mediaUrl, maxBytes);
      const contentUri = await uploadFile(client, media.buffer, {
        contentType: media.contentType,
        filename: media.fileName,
      });
      const msgtype = MsgType.File;
      const [firstChunk, ...rest] = chunks;
      const body = firstChunk ?? media.fileName ?? "(file)";
      const content = buildMediaContent({
        msgtype,
        body,
        url: contentUri,
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
    const rawThreadId = opts.threadId;
    const threadId =
      rawThreadId !== undefined && rawThreadId !== null
        ? String(rawThreadId).trim()
        : null;
    const response = await client.sendEvent(
      roomId,
      threadId ?? undefined,
      M_POLL_START as EventType.RoomMessage,
      pollContent as unknown as RoomMessageEventContent,
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
