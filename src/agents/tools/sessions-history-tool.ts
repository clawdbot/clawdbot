/**
 * sessions_history built-in tool.
 *
 * Reads bounded, redacted session transcript history after session visibility filtering.
 */
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { capArrayByJsonBytes } from "../../gateway/session-transcript-readers.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveSessionAgentId, resolveSessionAgentIds } from "../agent-scope.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import {
  describeSessionLinkRule,
  describeSessionsHistoryTool,
  SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { stripToolMessages } from "./chat-history-text.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import {
  resolveSessionToolTargetAgentId,
  runWithScopedSessionAccess,
} from "./scoped-session-access.js";
import {
  createSessionVisibilityRowChecker,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSandboxedSessionToolContext,
  resolveSessionToolAccess,
  resolveVisibleSessionReference,
  shouldResolveSessionIdInput,
} from "./sessions-helpers.js";

const SessionsHistoryToolSchema = Type.Object({
  sessionKey: Type.String(),
  limit: optionalPositiveIntegerSchema(),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  messageId: Type.Optional(Type.String({ minLength: 1 })),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  includeTools: Type.Optional(Type.Boolean()),
});

const SessionsHistoryOutputSchema = Type.Union([
  Type.Object(
    {
      sessionKey: Type.String(),
      messages: Type.Array(Type.Unknown()),
      truncated: Type.Boolean(),
      droppedMessages: Type.Boolean(),
      contentTruncated: Type.Boolean(),
      contentRedacted: Type.Boolean(),
      bytes: Type.Number(),
      sessionLinkRule: Type.Optional(
        Type.String({
          description: "How to build Control UI URLs for sessionKey values in this result.",
        }),
      ),
      offset: Type.Optional(Type.Number()),
      nextOffset: Type.Optional(Type.Number()),
      hasMore: Type.Optional(Type.Boolean()),
      totalMessages: Type.Optional(Type.Number()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Union([Type.Literal("error"), Type.Literal("forbidden")]),
      error: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

const SESSIONS_HISTORY_MAX_BYTES = 80 * 1024;
const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4000;
type GatewayCaller = AgentToolGatewayRequestCaller;
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
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (entry.type === "thinking" && typeof entry.thinking === "string") {
    const res = truncateHistoryText(entry.thinking);
    entry.thinking = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
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
  return asPositiveSafeInteger(seq);
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
  requesterAgentIdOverride?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
  sessionLinkBase?: string;
}): AnyAgentTool {
  return {
    label: "Session History",
    name: "sessions_history",
    displaySummary: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsHistoryTool({ sessionLinkBase: opts?.sessionLinkBase }),
    parameters: SessionsHistoryToolSchema,
    outputSchema: SessionsHistoryOutputSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const sessionKeyParam = readToolStringParam(params, "sessionKey", {
        required: true,
      });
      const limit = readPositiveIntegerParam(params, "limit");
      const offset = readOffsetParam(params);
      const messageId = readToolStringParam(params, "messageId");
      const sessionId = readToolStringParam(params, "sessionId");
      if (offset !== undefined && messageId) {
        throw new ToolInputError("offset and messageId cannot be used together");
      }
      if (sessionId && !messageId) {
        throw new ToolInputError("sessionId requires messageId");
      }
      const includeTools = Boolean(params.includeTools);
      const cfg = opts?.config ?? getRuntimeConfig();
      const { mainKey, alias, effectiveRequesterKey, mainSessionKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          requesterAgentId: opts?.requesterAgentIdOverride,
          sandboxed: opts?.sandboxed,
        });
      const requesterAgentId = resolveSessionAgentIds({
        config: cfg,
        sessionKey: effectiveRequesterKey,
        agentId: opts?.requesterAgentIdOverride,
      }).sessionAgentId;
      const normalizedInputKey = sessionKeyParam.trim();
      const isCurrentSession = normalizedInputKey === "current";
      const isConfiguredMainAlias =
        normalizedInputKey === "main" ||
        normalizedInputKey === "global" ||
        normalizedInputKey === mainKey ||
        normalizedInputKey === alias;
      const inputStoreOwner =
        shouldResolveSessionIdInput(sessionKeyParam) && !isConfiguredMainAlias
          ? { kind: "none" as const }
          : resolvePersistedSessionStoreOwnerForKey(cfg, sessionKeyParam);
      const resolvedSession = await resolveSessionReference({
        action: "history",
        sessionKey: sessionKeyParam,
        ...(isCurrentSession
          ? { agentId: requesterAgentId }
          : inputStoreOwner.kind === "configured"
            ? { agentId: inputStoreOwner.agentId }
            : {}),
        keyAgentId: requesterAgentId,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
        callGateway: gatewayCall,
      });
      if (!resolvedSession.ok) {
        return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
      }
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });
      const resolutionAccess = createSessionVisibilityRowChecker({
        action: "history",
        defaultAgentId:
          resolvedSession.agentId ??
          resolveSessionAgentId({ config: cfg, sessionKey: resolvedSession.key }),
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        visibility,
        a2aPolicy,
      }).check({ key: resolvedSession.key });
      const visibleSession = await resolveVisibleSessionReference({
        action: "history",
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        requesterAgentId,
        restrictToSpawned,
        visibilitySessionKey: sessionKeyParam,
        concealResolutionError: resolutionAccess.allowed ? undefined : resolutionAccess.error,
        callGateway: gatewayCall,
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
      const targetAgentId = resolveSessionToolTargetAgentId({
        cfg,
        targetSessionKey: resolvedKey,
        resolvedAgentId: visibleSession.agentId,
        requesterAgentId,
      });

      const authorizationKey =
        targetAgentId !== requesterAgentId && !parseAgentSessionKey(resolvedKey)
          ? `agent:${targetAgentId}:${resolvedKey}`
          : resolvedKey;
      const access = await resolveSessionToolAccess({
        action: "history",
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        authorizationTargetSessionKey: authorizationKey,
        targetAgentId,
        targetSessionKey: resolvedKey,
        requesterOwned: visibleSession.requesterOwned,
        visibility,
        a2aPolicy,
        callGateway: gatewayCall,
      });
      if (!access.allowed) {
        return jsonResult({
          status: access.status,
          error: access.error,
        });
      }

      const result = await runWithScopedSessionAccess({
        cfg,
        agentId: targetAgentId,
        expectedSessionId: access.expectedSessionId,
        targetSessionKey: resolvedKey,
        run: async () =>
          await gatewayCall<{
            messages: Array<unknown>;
            offset?: number;
            nextOffset?: number;
            hasMore?: boolean;
            totalMessages?: number;
          }>({
            method: "chat.history",
            params: {
              sessionKey: resolvedKey,
              agentId: targetAgentId,
              limit,
              ...(offset !== undefined ? { offset } : {}),
              ...(messageId ? { messageId } : {}),
              ...(sessionId ? { sessionId } : {}),
            },
          }),
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
        ...(opts?.sessionLinkBase
          ? { sessionLinkRule: describeSessionLinkRule(opts.sessionLinkBase) }
          : {}),
        ...pagination,
      });
    },
  };
}
