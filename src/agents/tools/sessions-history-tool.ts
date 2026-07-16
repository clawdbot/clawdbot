/**
 * sessions_history built-in tool.
 *
 * Reads bounded, redacted session transcript history after session visibility filtering.
 */
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { capArrayByJsonBytes } from "../../gateway/session-transcript-readers.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { truncateUtf16Safe } from "../../utils.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import {
  describeSessionsHistoryTool,
  SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { stripToolMessages } from "./chat-history-text.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringParam,
  ToolInputError,
} from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSandboxedSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

const SessionsHistoryToolSchema = Type.Object({
  sessionKey: Type.String(),
  limit: optionalPositiveIntegerSchema(),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  messageId: Type.Optional(Type.String({ minLength: 1 })),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  includeTools: Type.Optional(Type.Boolean()),
});

const SESSIONS_HISTORY_MAX_BYTES = 80 * 1024;
const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4000;
type GatewayCaller = typeof callGateway;
type ChatHistoryPaginationMetadata = {
  offset?: number;
  nextOffset?: number;
  hasMore?: boolean;
  totalMessages?: number;
};

function readOffsetParam(params: Record<string, unknown>): number | undefined {
  const offset = readNonNegativeIntegerParam(params, "offset");
  if (params.offset !== undefined && offset === undefined) {
    throw new ToolInputError("offset must be a non-negative integer");
  }
  return offset;
}

// sandbox policy handling is shared with sessions-list-tool via sessions-helpers.ts

function truncateHistoryText(text: string): {
  text: string;
  truncated: boolean;
  redacted: boolean;
} {
  // sessions_history is a tool surface, not a log sink. Keep it redacted even
  // when operators disable general-purpose log redaction.
  const sanitized = redactToolPayloadText(text);
  const redacted = sanitized !== text;
  if (sanitized.length <= SESSIONS_HISTORY_TEXT_MAX_CHARS) {
    return { text: sanitized, truncated: false, redacted };
  }
  const cut = truncateUtf16Safe(sanitized, SESSIONS_HISTORY_TEXT_MAX_CHARS);
  return { text: `${cut}\n…(truncated)…`, truncated: true, redacted };
}

function sanitizeHistoryContentBlock(block: unknown): {
  block: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!block || typeof block !== "object") {
    return { block, truncated: false, redacted: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;
  const type = typeof entry.type === "string" ? entry.type : "";
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (type === "thinking") {
    if (typeof entry.thinking === "string") {
      const res = truncateHistoryText(entry.thinking);
      entry.thinking = res.text;
      truncated ||= res.truncated;
      redacted ||= res.redacted;
    }
    // The encrypted signature can be extremely large and is not useful for history recall.
    if ("thinkingSignature" in entry) {
      delete entry.thinkingSignature;
      truncated = true;
    }
    if ("openclawReasoningReplay" in entry) {
      delete entry.openclawReasoningReplay;
      truncated = true;
    }
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (type === "image") {
    const data = readStringValue(entry.data);
    const existingBytes = typeof entry.bytes === "number" ? entry.bytes : undefined;
    const bytes = data === undefined ? existingBytes : estimateBase64DecodedBytes(data);
    if ("data" in entry) {
      delete entry.data;
      truncated = true;
    }
    entry.omitted = true;
    if (bytes !== undefined) {
      entry.bytes = bytes;
    }
  }
  return { block: entry, truncated, redacted };
}

function sanitizeHistoryMessage(message: unknown): {
  message: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!message || typeof message !== "object") {
    return { message, truncated: false, redacted: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;
  // Tool result details often contain very large nested payloads.
  if ("details" in entry) {
    delete entry.details;
    truncated = true;
  }
  if ("usage" in entry) {
    delete entry.usage;
    truncated = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    truncated = true;
  }

  if (typeof entry.content === "string") {
    const res = truncateHistoryText(entry.content);
    entry.content = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeHistoryContentBlock(block));
    entry.content = updated.map((item) => item.block);
    truncated ||= updated.some((item) => item.truncated);
    redacted ||= updated.some((item) => item.redacted);
  }
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  return { message: entry, truncated, redacted };
}

function enforceSessionsHistoryHardCap(params: {
  items: unknown[];
  bytes: number;
  maxBytes: number;
}): { items: unknown[]; bytes: number; hardCapped: boolean } {
  if (params.bytes <= params.maxBytes) {
    return { items: params.items, bytes: params.bytes, hardCapped: false };
  }

  const last = params.items.at(-1);
  const lastOnly = last ? [last] : [];
  const lastBytes = jsonUtf8Bytes(lastOnly);
  if (lastBytes <= params.maxBytes) {
    return { items: lastOnly, bytes: lastBytes, hardCapped: true };
  }

  const placeholder = [buildSessionsHistoryOmittedPlaceholder(last)];
  return { items: placeholder, bytes: jsonUtf8Bytes(placeholder), hardCapped: true };
}

function readHistoryMessageSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const meta = (message as Record<string, unknown>)["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const seq = (meta as Record<string, unknown>).seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

function readHistoryMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const meta = (message as Record<string, unknown>)["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const id = (meta as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function capSessionsHistoryAroundMessage(
  items: unknown[],
  messageId: string,
  maxBytes: number,
): { items: unknown[]; bytes: number } {
  const anchorIndex = items.findIndex((item) => readHistoryMessageId(item) === messageId);
  if (anchorIndex === -1) {
    return capArrayByJsonBytes(items, maxBytes);
  }

  let start = anchorIndex;
  let end = anchorIndex + 1;
  let cappedItems = items.slice(start, end);
  let bytes = jsonUtf8Bytes(cappedItems);
  let canGrowOlder = start > 0;
  let canGrowNewer = end < items.length;
  while (canGrowOlder || canGrowNewer) {
    if (canGrowOlder) {
      const candidate = items.slice(start - 1, end);
      const candidateBytes = jsonUtf8Bytes(candidate);
      if (candidateBytes <= maxBytes) {
        start -= 1;
        cappedItems = candidate;
        bytes = candidateBytes;
      } else {
        canGrowOlder = false;
      }
    }
    canGrowOlder &&= start > 0;

    if (canGrowNewer) {
      const candidate = items.slice(start, end + 1);
      const candidateBytes = jsonUtf8Bytes(candidate);
      if (candidateBytes <= maxBytes) {
        end += 1;
        cappedItems = candidate;
        bytes = candidateBytes;
      } else {
        canGrowNewer = false;
      }
    }
    canGrowNewer &&= end < items.length;
  }
  return { items: cappedItems, bytes };
}

function buildSessionsHistoryOmittedPlaceholder(source: unknown): Record<string, unknown> {
  const seq = readHistoryMessageSeq(source);
  const id = readHistoryMessageId(source);
  return {
    role: "assistant",
    content: "[sessions_history omitted: message too large]",
    ...(seq !== undefined || id !== undefined
      ? {
          __openclaw: {
            ...(seq !== undefined ? { seq } : {}),
            ...(id !== undefined ? { id } : {}),
          },
        }
      : {}),
  };
}

function resolveSessionsHistoryPaginationMetadata(params: {
  messages: unknown[];
  result: ChatHistoryPaginationMetadata | undefined;
  requestedOffset: number | undefined;
  requestedMessageId: string | undefined;
}): ChatHistoryPaginationMetadata {
  const result = params.result;
  if (params.requestedMessageId) {
    return typeof result?.totalMessages === "number" ? { totalMessages: result.totalMessages } : {};
  }
  const offset =
    typeof result?.offset === "number"
      ? result.offset
      : params.requestedOffset !== undefined
        ? params.requestedOffset
        : undefined;
  if (offset === undefined) {
    return {};
  }

  const totalMessages =
    typeof result?.totalMessages === "number" ? result.totalMessages : undefined;
  if (totalMessages === undefined) {
    return {
      offset,
      ...(typeof result?.nextOffset === "number" ? { nextOffset: result.nextOffset } : {}),
      ...(typeof result?.hasMore === "boolean" ? { hasMore: result.hasMore } : {}),
    };
  }

  // Gateway offsets count newest transcript rows already returned. Recompute
  // from the oldest surviving seq after this tool's own filter/cap passes.
  const oldestSeq = params.messages
    .map((message) => readHistoryMessageSeq(message))
    .find((seq): seq is number => typeof seq === "number");
  const nextOffset =
    oldestSeq !== undefined
      ? Math.max(offset, totalMessages - oldestSeq + 1)
      : typeof result?.nextOffset === "number"
        ? result.nextOffset
        : undefined;
  const hasMore =
    nextOffset !== undefined
      ? nextOffset < totalMessages
      : typeof result?.hasMore === "boolean"
        ? result.hasMore
        : undefined;
  return {
    offset,
    ...(hasMore === true && nextOffset !== undefined ? { nextOffset } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    totalMessages,
  };
}

export function createSessionsHistoryTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session History",
    name: "sessions_history",
    displaySummary: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsHistoryTool(),
    parameters: SessionsHistoryToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const sessionKeyParam = readStringParam(params, "sessionKey", {
        required: true,
      });
      const cfg = opts?.config ?? getRuntimeConfig();
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const resolvedSession = await resolveSessionReference({
        sessionKey: sessionKeyParam,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKeyParam,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          status: visibleSession.status,
          error: visibleSession.error,
        });
      }
      // From here on, use the canonical key (sessionId inputs already resolved).
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          status: access.status,
          error: access.error,
        });
      }

      const limit = readPositiveIntegerParam(params, "limit");
      const offset = readOffsetParam(params);
      const messageId = readStringParam(params, "messageId");
      const sessionId = readStringParam(params, "sessionId");
      if (offset !== undefined && messageId) {
        throw new ToolInputError("offset and messageId cannot be used together");
      }
      if (sessionId && !messageId) {
        throw new ToolInputError("sessionId requires messageId");
      }
      const includeTools = Boolean(params.includeTools);
      const result = await gatewayCall<{
        messages: Array<unknown>;
        offset?: number;
        nextOffset?: number;
        hasMore?: boolean;
        totalMessages?: number;
      }>({
        method: "chat.history",
        params: {
          sessionKey: resolvedKey,
          limit,
          ...(offset !== undefined ? { offset } : {}),
          ...(messageId ? { messageId } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
      });
      const rawMessages = Array.isArray(result?.messages) ? result.messages : [];
      const selectedMessages = includeTools ? rawMessages : stripToolMessages(rawMessages);
      const sanitizedMessages = selectedMessages.map((message) => sanitizeHistoryMessage(message));
      const contentTruncated = sanitizedMessages.some((entry) => entry.truncated);
      const contentRedacted = sanitizedMessages.some((entry) => entry.redacted);
      const sanitizedItems = sanitizedMessages.map((entry) => entry.message);
      const cappedMessages = messageId
        ? capSessionsHistoryAroundMessage(sanitizedItems, messageId, SESSIONS_HISTORY_MAX_BYTES)
        : capArrayByJsonBytes(sanitizedItems, SESSIONS_HISTORY_MAX_BYTES);
      const droppedMessages = cappedMessages.items.length < selectedMessages.length;
      const hardened = enforceSessionsHistoryHardCap({
        items: cappedMessages.items,
        bytes: cappedMessages.bytes,
        maxBytes: SESSIONS_HISTORY_MAX_BYTES,
      });
      const pagination = resolveSessionsHistoryPaginationMetadata({
        messages: hardened.items,
        result,
        requestedOffset: offset,
        requestedMessageId: messageId,
      });
      return jsonResult({
        sessionKey: displayKey,
        messages: hardened.items,
        truncated: droppedMessages || contentTruncated || hardened.hardCapped,
        droppedMessages: droppedMessages || hardened.hardCapped,
        contentTruncated,
        contentRedacted,
        bytes: hardened.bytes,
        ...pagination,
      });
    },
  };
}
