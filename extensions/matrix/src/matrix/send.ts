import {
  createMessageReceiptFromOutboundResults,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-message";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { PollInput } from "../runtime-api.js";
import { getMatrixRuntime } from "../runtime.js";
import type { CoreConfig } from "../types.js";
import { loadOutboundMediaFromUrl } from "./outbound-media-runtime.js";
import { buildPollStartContent, M_POLL_START } from "./poll-types.js";
import { buildMatrixReactionContent } from "./reaction-common.js";
import type { MatrixClient } from "./sdk.js";
import {
  resolveMediaMaxBytes,
  withResolvedMatrixControlClient,
  withResolvedMatrixSendClient,
} from "./send/client.js";
import {
  buildReplyRelation,
  buildTextContent,
  buildThreadRelation,
  diffMatrixMentions,
  enrichMatrixFormattedContent,
  extractMatrixMentions,
  resolveMatrixMentionsForBody,
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
  MSC4357_LIVE_KEY,
  MsgType,
  RelationType,
  type MatrixExtraContentFields,
  type MatrixOutboundContent,
  type MatrixSendOpts,
  type MatrixSendResult,
  type MatrixTextMsgType,
} from "./send/types.js";

const MATRIX_TEXT_LIMIT = 4000;
const getCore = () => getMatrixRuntime();

export type { MatrixSendOpts, MatrixSendResult } from "./send/types.js";
export { resolveMatrixRoomId } from "./send/targets.js";

export type MatrixPreparedSingleText = {
  trimmedText: string;
  convertedText: string;
  singleEventLimit: number;
  fitsInSingleEvent: boolean;
};

export type MatrixPreparedChunkedText = MatrixPreparedSingleText & {
  chunks: string[];
};

type MatrixClientResolveOpts = {
  client?: MatrixClient;
  cfg?: CoreConfig;
  timeoutMs?: number;
  accountId?: string | null;
};

function createMatrixSendReceipt(params: {
  roomId: string;
  platformMessageIds: readonly string[];
  kind: MessageReceiptPartKind;
  replyToId?: string;
  threadId?: string | null;
}) {
  return createMessageReceiptFromOutboundResults({
    kind: params.kind,
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    results: params.platformMessageIds.map((messageId) => ({
      channel: "matrix",
      messageId,
      roomId: params.roomId,
    })),
  });
}

function isMatrixClient(value: MatrixClient | MatrixClientResolveOpts): value is MatrixClient {
  return typeof (value as { sendEvent?: unknown }).sendEvent === "function";
}

function normalizeMatrixClientResolveOpts(
  opts?: MatrixClient | MatrixClientResolveOpts,
): MatrixClientResolveOpts {
  if (!opts) {
    return {};
  }
  if (isMatrixClient(opts)) {
    return { client: opts };
  }
  return {
    client: opts.client,
    cfg: opts.cfg,
    timeoutMs: opts.timeoutMs,
    accountId: opts.accountId,
  };
}

function resolvePreviousEditContent(previousEvent: unknown): Record<string, unknown> | undefined {
  if (!previousEvent || typeof previousEvent !== "object") {
    return undefined;
  }
  const eventRecord = previousEvent as { content?: unknown };
  if (!eventRecord.content || typeof eventRecord.content !== "object") {
    return undefined;
  }
  const content = eventRecord.content as Record<string, unknown>;
  const newContent = content["m.new_content"];
  return newContent && typeof newContent === "object"
    ? (newContent as Record<string, unknown>)
    : content;
}

function hasMatrixMentionsMetadata(content: Record<string, unknown> | undefined): boolean {
  return Boolean(content && Object.hasOwn(content, "m.mentions"));
}

function withMatrixExtraContentFields<T extends Record<string, unknown>>(
  content: T,
  extraContent?: MatrixExtraContentFields,
): T {
  if (!extraContent) {
    return content;
  }
  return { ...content, ...extraContent };
}

async function resolvePreviousEditMentions(params: {
  client: MatrixClient;
  content: Record<string, unknown> | undefined;
}) {
  if (hasMatrixMentionsMetadata(params.content)) {
    return extractMatrixMentions(params.content);
  }
  const body = typeof params.content?.body === "string" ? params.content.body : "";
  if (!body) {
    return {};
  }
  return await resolveMatrixMentionsForBody({
    client: params.client,
    body,
  });
}

export function prepareMatrixSingleText(
  text: string,
  opts: {
    cfg: CoreConfig;
    accountId?: string;
    tableMode?: MarkdownTableMode;
  },
): MatrixPreparedSingleText {
  const trimmedText = text.trim();
  const cfg = requireRuntimeConfig(opts.cfg, "Matrix text preparation") as CoreConfig;
  const tableMode =
    opts.tableMode ??
    getCore().channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "matrix",
      accountId: opts.accountId,
    });
  const convertedText = getCore().channel.text.convertMarkdownTables(trimmedText, tableMode);
  const singleEventLimit = Math.min(
    getCore().channel.text.resolveTextChunkLimit(cfg, "matrix", opts.accountId),
    MATRIX_TEXT_LIMIT,
  );
  return {
    trimmedText,
    convertedText,
    singleEventLimit,
    fitsInSingleEvent: convertedText.length <= singleEventLimit,
  };
}

export function chunkMatrixText(
  text: string,
  opts: {
    cfg: CoreConfig;
    accountId?: string;
    tableMode?: MarkdownTableMode;
  },
): MatrixPreparedChunkedText {
  const preparedText = prepareMatrixSingleText(text, opts);
  const cfg = requireRuntimeConfig(opts.cfg, "Matrix text chunking") as CoreConfig;
  const chunkMode = getCore().channel.text.resolveChunkMode(cfg, "matrix", opts.accountId);
  return {
    ...preparedText,
    chunks: getCore().channel.text.chunkMarkdownTextWithMode(
      preparedText.convertedText,
      preparedText.singleEventLimit,
      chunkMode,
    ),
  };
}

export async function sendMessageMatrix(
  to: string,
  message: string | undefined,
  opts: MatrixSendOpts,
): Promise<MatrixSendResult> {
  const trimmedMessage = message?.trim() ?? "";
  if (!trimmedMessage && !opts.mediaUrl) {
    throw new Error("Matrix send requires text or media");
  }
  return await withResolvedMatrixSendClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      timeoutMs: opts.timeoutMs,
      accountId: opts.accountId,
    },
    async (client) => {
      const roomId = await resolveMatrixRoomId(client, to);
      const cfg = requireRuntimeConfig(opts.cfg, "Matrix send") as CoreConfig;
      const { chunks } = chunkMatrixText(trimmedMessage, {
        cfg,
        accountId: opts.accountId,
      });
      const threadId = normalizeThreadId(opts.threadId);
      const relation = threadId
        ? buildThreadRelation(threadId, opts.replyToId)
        : buildReplyRelation(opts.replyToId);
      let pendingExtraContent = opts.extraContent;
      const sendContent = async (content: MatrixOutboundContent) => {
        const contentWithExtra = withMatrixExtraContentFields(content, pendingExtraContent);
        pendingExtraContent = undefined;
        const eventId = await client.sendMessage(roomId, contentWithExtra);
        return eventId;
      };

      const platformMessageIds: string[] = [];
      let lastMessageId = "";
      let receiptKind: MessageReceiptPartKind = "text";
      if (opts.mediaUrl) {
        const maxBytes = resolveMediaMaxBytes(opts.accountId, cfg);
        const media = await loadOutboundMediaFromUrl(opts.mediaUrl, {
          maxBytes,
          mediaAccess: opts.mediaAccess,
          mediaLocalRoots: opts.mediaLocalRoots,
          mediaReadFile: opts.mediaReadFile,
        });
        const uploaded = await uploadMediaMaybeEncrypted(client, roomId, media.buffer, {
          contentType: media.contentType,
          filename: media.fileName,
        });
        const durationMs = await resolveMediaDurationMs({
          buffer: media.buffer,
          contentType: media.contentType,
          fileName: media.fileName,
          kind: media.kind ?? "unknown",
        });
        const baseMsgType = resolveMatrixMsgType(media.contentType, media.fileName);
        const { useVoice } = resolveMatrixVoiceDecision({
          wantsVoice: opts.audioAsVoice === true,
          contentType: media.contentType,
          fileName: media.fileName,
        });
        const msgtype = useVoice ? MsgType.Audio : baseMsgType;
        receiptKind = useVoice ? "voice" : "media";
        const isImage = msgtype === MsgType.Image;
        const imageInfo = isImage
          ? await prepareImageInfo({
              buffer: media.buffer,
              client,
              encrypted: Boolean(uploaded.file),
            })
          : undefined;
        const [firstChunk, ...rest] = chunks;
        const captionMarkdown = useVoice ? "" : (firstChunk ?? "");
        const body = useVoice ? "Voice message" : captionMarkdown || media.fileName || "(file)";
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
        await enrichMatrixFormattedContent({
          client,
          content,
          markdown: captionMarkdown,
        });
        const eventId = await sendContent(content);
        lastMessageId = eventId ?? lastMessageId;
        if (eventId) {
          platformMessageIds.push(eventId);
        }
        const textChunks = useVoice ? chunks : rest;
        // Voice messages use a generic media body ("Voice message"), so keep any
        // transcript follow-up attached to the same reply/thread context.
        const followupRelation = useVoice || threadId ? relation : undefined;
        for (const chunk of textChunks) {
          const text = chunk.trim();
          if (!text) {
            continue;
          }
          const followup = buildTextContent(text, followupRelation);
          await enrichMatrixFormattedContent({
            client,
            content: followup,
            markdown: text,
          });
          const followupEventId = await sendContent(followup);
          lastMessageId = followupEventId ?? lastMessageId;
          if (followupEventId) {
            platformMessageIds.push(followupEventId);
          }
        }
      } else {
        for (const chunk of chunks.length ? chunks : [""]) {
          const text = chunk.trim();
          if (!text) {
            continue;
          }
          const content = buildTextContent(text, relation);
          await enrichMatrixFormattedContent({
            client,
            content,
            markdown: text,
          });
          const eventId = await sendContent(content);
          lastMessageId = eventId ?? lastMessageId;
          if (eventId) {
            platformMessageIds.push(eventId);
          }
        }
      }

      return {
        messageId: lastMessageId || "unknown",
        roomId,
        primaryMessageId: platformMessageIds[0] ?? (lastMessageId || "unknown"),
        receipt: createMatrixSendReceipt({
          roomId,
          platformMessageIds,
          kind: receiptKind,
          replyToId: opts.replyToId,
          threadId,
        }),
      };
    },
  );
}

export async function sendPollMatrix(
  to: string,
  poll: PollInput,
  opts: MatrixSendOpts,
): Promise<{ eventId: string; roomId: string }> {
  if (!poll.question?.trim()) {
    throw new Error("Matrix poll requires a question");
  }
  if (!poll.options?.length) {
    throw new Error("Matrix poll requires options");
  }
  return await withResolvedMatrixSendClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      timeoutMs: opts.timeoutMs,
      accountId: opts.accountId,
    },
    async (client) => {
      const roomId = await resolveMatrixRoomId(client, to);
      const pollContent = buildPollStartContent(poll);
      const fallbackText =
        pollContent["m.text"] ?? pollContent["org.matrix.msc1767.text"] ?? poll.question ?? "";
      const mentions = await resolveMatrixMentionsForBody({
        client,
        body: fallbackText,
      });
      const threadId = normalizeThreadId(opts.threadId);
      const pollPayload: Record<string, unknown> = threadId
        ? { ...pollContent, "m.relates_to": buildThreadRelation(threadId) }
        : { ...pollContent };
      pollPayload["m.mentions"] = mentions;
      const eventId = await client.sendEvent(roomId, M_POLL_START, pollPayload);

      return {
        eventId: eventId ?? "unknown",
        roomId,
      };
    },
  );
}

export async function sendTypingMatrix(
  roomId: string,
  typing: boolean,
  optsOrTimeoutMs?: number | MatrixClientResolveOpts,
  client?: MatrixClient,
): Promise<void> {
  const opts =
    typeof optsOrTimeoutMs === "number"
      ? { timeoutMs: optsOrTimeoutMs, ...(client ? { client } : {}) }
      : {
          ...normalizeMatrixClientResolveOpts(optsOrTimeoutMs),
          ...(client ? { client } : {}),
        };
  await withResolvedMatrixControlClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      timeoutMs: opts.timeoutMs,
      accountId: opts.accountId,
    },
    async (resolved) => {
      const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
      const resolvedTimeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 30_000;
      await resolved.setTyping(resolvedRoom, typing, resolvedTimeoutMs);
    },
  );
}

export async function sendReadReceiptMatrix(
  roomId: string,
  eventId: string,
  client?: MatrixClient,
): Promise<void> {
  if (!eventId?.trim()) {
    return;
  }
  await withResolvedMatrixControlClient({ client }, async (resolved) => {
    const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
    await resolved.sendReadReceipt(resolvedRoom, eventId.trim());
  });
}

export async function sendSingleTextMessageMatrix(
  roomId: string,
  text: string,
  opts: {
    client?: MatrixClient;
    cfg: CoreConfig;
    replyToId?: string;
    threadId?: string;
    accountId?: string;
    msgtype?: MatrixTextMsgType;
    includeMentions?: boolean;
    extraContent?: MatrixExtraContentFields;
    /** When true, marks the message as a live/streaming update (MSC4357). */
    live?: boolean;
  },
): Promise<MatrixSendResult> {
  const { trimmedText, convertedText, singleEventLimit, fitsInSingleEvent } =
    prepareMatrixSingleText(text, {
      cfg: opts.cfg,
      accountId: opts.accountId,
    });
  if (!trimmedText) {
    throw new Error("Matrix single-message send requires text");
  }
  if (!fitsInSingleEvent) {
    throw new Error(
      `Matrix single-message text exceeds limit (${convertedText.length} > ${singleEventLimit})`,
    );
  }
  return await withResolvedMatrixSendClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      accountId: opts.accountId,
    },
    async (client) => {
      const resolvedRoom = await resolveMatrixRoomId(client, roomId);
      const normalizedThreadId = normalizeThreadId(opts.threadId);
      const relation = normalizedThreadId
        ? buildThreadRelation(normalizedThreadId, opts.replyToId)
        : buildReplyRelation(opts.replyToId);
      const content = withMatrixExtraContentFields(
        buildTextContent(convertedText, relation, {
          msgtype: opts.msgtype,
        }),
        opts.extraContent,
      );
      await enrichMatrixFormattedContent({
        client,
        content,
        markdown: convertedText,
        includeMentions: opts.includeMentions,
      });
      // MSC4357: mark the initial message as live so supporting clients start
      // rendering a streaming animation immediately.
      if (opts.live) {
        (content as Record<string, unknown>)[MSC4357_LIVE_KEY] = {};
      }
      const eventId = await client.sendMessage(resolvedRoom, content);
      const platformMessageIds = eventId ? [eventId] : [];
      return {
        messageId: eventId ?? "unknown",
        roomId: resolvedRoom,
        primaryMessageId: eventId ?? "unknown",
        receipt: createMatrixSendReceipt({
          roomId: resolvedRoom,
          platformMessageIds,
          kind: "text",
          replyToId: opts.replyToId,
          threadId: normalizedThreadId,
        }),
      };
    },
  );
}

async function getPreviousMatrixEvent(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const getEvent = (
    client as {
      getEvent?: (roomId: string, eventId: string) => Promise<Record<string, unknown>>;
    }
  ).getEvent;
  if (typeof getEvent !== "function") {
    return null;
  }
  return await Promise.resolve(getEvent.call(client, roomId, eventId)).catch(() => null);
}

export async function editMessageMatrix(
  roomId: string,
  originalEventId: string,
  newText: string,
  opts: {
    client?: MatrixClient;
    cfg: CoreConfig;
    threadId?: string;
    accountId?: string;
    timeoutMs?: number;
    msgtype?: MatrixTextMsgType;
    includeMentions?: boolean;
    extraContent?: MatrixExtraContentFields;
    /** When true, marks the edit as a live/streaming update (MSC4357). */
    live?: boolean;
  },
): Promise<string> {
  return await withResolvedMatrixSendClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      accountId: opts.accountId,
      timeoutMs: opts.timeoutMs,
    },
    async (client) => {
      const resolvedRoom = await resolveMatrixRoomId(client, roomId);
      const cfg = requireRuntimeConfig(opts.cfg, "Matrix message edit") as CoreConfig;
      const tableMode = getCore().channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "matrix",
        accountId: opts.accountId,
      });
      const convertedText = getCore().channel.text.convertMarkdownTables(newText, tableMode);
      const newContent = withMatrixExtraContentFields(
        buildTextContent(convertedText, undefined, {
          msgtype: opts.msgtype,
        }),
        opts.extraContent,
      );
      await enrichMatrixFormattedContent({
        client,
        content: newContent,
        markdown: convertedText,
        includeMentions: opts.includeMentions,
      });
      const replaceMentions =
        opts.includeMentions === false
          ? undefined
          : diffMatrixMentions(
              extractMatrixMentions(newContent),
              await resolvePreviousEditMentions({
                client,
                content: resolvePreviousEditContent(
                  await getPreviousMatrixEvent(client, resolvedRoom, originalEventId),
                ),
              }),
            );

      const replaceRelation: Record<string, unknown> = {
        rel_type: RelationType.Replace,
        event_id: originalEventId,
      };
      const threadId = normalizeThreadId(opts.threadId);
      if (threadId) {
        // Thread-aware replace: Synapse needs the thread context to keep the
        // edited event visible in the thread timeline.
        replaceRelation["m.in_reply_to"] = { event_id: threadId };
      }

      // Spread newContent into the outer event so clients that don't support
      // m.new_content still see properly formatted text (with HTML).
      const content: Record<string, unknown> = {
        ...newContent,
        body: `* ${convertedText}`,
        ...(typeof newContent.formatted_body === "string"
          ? { formatted_body: `* ${newContent.formatted_body}` }
          : {}),
        "m.new_content": newContent,
        "m.relates_to": replaceRelation,
      };
      if (replaceMentions !== undefined) {
        content["m.mentions"] = replaceMentions;
      }

      // MSC4357: mark in-progress edits so supporting clients can render a
      // streaming animation. The marker is placed in both the outer content
      // (for unencrypted rooms / server-side aggregation) and inside
      // m.new_content (for E2EE rooms where only decrypted content is read).
      if (opts.live) {
        content[MSC4357_LIVE_KEY] = {};
        (content["m.new_content"] as Record<string, unknown>)[MSC4357_LIVE_KEY] = {};
      }

      const eventId = await client.sendMessage(resolvedRoom, content);
      return eventId ?? "";
    },
  );
}

export async function reactMatrixMessage(
  roomId: string,
  messageId: string,
  emoji: string,
  opts?: MatrixClient | MatrixClientResolveOpts,
): Promise<void> {
  const clientOpts = normalizeMatrixClientResolveOpts(opts);
  await withResolvedMatrixSendClient(
    {
      client: clientOpts.client,
      cfg: clientOpts.cfg,
      timeoutMs: clientOpts.timeoutMs,
      accountId: clientOpts.accountId ?? undefined,
    },
    async (resolved) => {
      const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
      const reaction = buildMatrixReactionContent(messageId, emoji);
      await resolved.sendEvent(resolvedRoom, EventType.Reaction, reaction);
    },
  );
}
