import { readSessionMessageSequence } from "@openclaw/gateway-client/browser";
import type {
  ChatInputConsumptions,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow, GatewaySessionsDefaults } from "../../api/types.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-store.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { cacheChatSessionSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";

export type ChatHistoryResult = {
  pendingInputs?: ChatPendingInputsPage;
  inputConsumptions?: ChatInputConsumptions;
  sourceCanonicalListRevision?: number;
  deltaCursor?: string;
  messages?: Array<unknown>;
  offset?: number;
  nextOffset?: number;
  hasMore?: boolean;
  totalMessages?: number;
  completeSnapshot?: boolean;
  sessionId?: string;
  thinkingLevel?: string;
  verboseLevel?: string;
  defaults?: GatewaySessionsDefaults;
  sessionInfo?: GatewaySessionRow;
  metadata?: ChatMetadataResult;
  inFlightRun?: {
    runId: string;
    text?: string;
    startedAt?: number;
    sessionAbortable?: boolean;
    events?: Array<{
      runId: string;
      seq: number;
      stream: string;
      ts: number;
      sessionKey?: string;
      agentId?: string;
      data: Record<string, unknown>;
    }>;
    plan?: { steps: Array<{ step: string; status: string }>; explanation?: string };
  };
};

export type ChatHistoryDeltaResult = {
  pendingInputs?: ChatPendingInputsPage;
  inputConsumptions?: ChatInputConsumptions;
  kind: "delta";
  messages: unknown[];
  deltaCursor: string;
  sessionInfo: GatewaySessionRow;
  inFlightRun?: ChatHistoryResult["inFlightRun"];
  metadata?: ChatMetadataResult;
};

export type ChatHistoryResetResult = { kind: "reset" };

export type ChatHistoryResponse =
  | ChatHistoryResult
  | ChatHistoryDeltaResult
  | ChatHistoryResetResult;

export function isHistoryCursor(
  result: ChatHistoryResponse,
): result is ChatHistoryDeltaResult | ChatHistoryResetResult {
  return "kind" in result;
}

export function resolveChatHistoryPagination(
  result: ChatHistoryResult | undefined,
): ChatHistoryPagination {
  const totalMessages = result?.totalMessages;
  const validTotal =
    typeof totalMessages === "number" && Number.isSafeInteger(totalMessages) && totalMessages >= 0
      ? totalMessages
      : undefined;
  const nextOffset = result?.nextOffset;
  if (
    result?.hasMore === true &&
    typeof nextOffset === "number" &&
    Number.isSafeInteger(nextOffset) &&
    nextOffset > 0
  ) {
    return {
      hasMore: true,
      nextOffset,
      ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    };
  }
  return {
    hasMore: false,
    ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    ...(result?.completeSnapshot === true ? { completeSnapshot: true as const } : {}),
  };
}

export function historySessionId(result: ChatHistoryResult): string | null {
  if (typeof result.sessionInfo?.sessionId === "string" && result.sessionInfo.sessionId.trim()) {
    return result.sessionInfo.sessionId.trim();
  }
  return typeof result.sessionId === "string" && result.sessionId.trim()
    ? result.sessionId.trim()
    : null;
}

function retainedRawHistoryStart(pagination: ChatHistoryPagination): number | null {
  const totalMessages = pagination.totalMessages;
  if (
    typeof totalMessages !== "number" ||
    !Number.isSafeInteger(totalMessages) ||
    totalMessages < 0
  ) {
    return null;
  }
  const retainedDepth = pagination.hasMore ? pagination.nextOffset : totalMessages;
  const start = totalMessages - retainedDepth + 1;
  return Number.isSafeInteger(start) && start > 0 ? start : null;
}

export function reconcileHistoryTail(options: {
  nextMessages: unknown[];
  nextPagination: ChatHistoryPagination;
  nextSessionId: string | null;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination;
  previousSessionId: string | null;
}): { messages: unknown[]; pagination: ChatHistoryPagination } | null {
  if (
    !options.previousSessionId ||
    options.previousSessionId !== options.nextSessionId ||
    options.previousMessages.length === 0
  ) {
    return null;
  }
  const previousTotal = options.previousPagination.totalMessages;
  const nextTotal = options.nextPagination.totalMessages;
  const previousStart = retainedRawHistoryStart(options.previousPagination);
  const nextStart = retainedRawHistoryStart(options.nextPagination);
  if (
    typeof previousTotal !== "number" ||
    typeof nextTotal !== "number" ||
    previousStart === null ||
    nextStart === null ||
    nextTotal < previousTotal ||
    nextStart > previousTotal + 1 ||
    nextStart <= previousStart
  ) {
    return null;
  }
  const prefix = options.previousMessages.filter((message) => {
    const seq = readSessionMessageSequence(message);
    return seq !== null && seq < nextStart;
  });
  if (prefix.length === 0) {
    return null;
  }
  const retainedDepth = nextTotal - previousStart + 1;
  return {
    messages: [...prefix, ...options.nextMessages],
    pagination:
      previousStart > 1
        ? { hasMore: true, nextOffset: retainedDepth, totalMessages: nextTotal }
        : { hasMore: false, totalMessages: nextTotal },
  };
}

export function commitCurrentChatHistorySnapshot(
  state: ChatState,
  deltaCursor?: string | null,
): void {
  if (!state.chatMessagesBySession) {
    return;
  }
  const sessionKey = state.sessionKey;
  const agentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const cachedDeltaCursor =
    deltaCursor === undefined
      ? readChatSessionSnapshot(state.chatMessagesBySession, state, {
          sessionKey,
          agentId,
        })?.deltaCursor
      : (deltaCursor ?? undefined);
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    {
      ...(cachedDeltaCursor !== undefined ? { deltaCursor: cachedDeltaCursor } : {}),
      ...(state.chatDisplayedLeafEntryId !== undefined
        ? { displayedLeafEntryId: state.chatDisplayedLeafEntryId }
        : {}),
      messages: state.chatMessages,
      pagination: state.chatHistoryPagination,
      sessionId: state.currentSessionId ?? null,
    },
  );
}

export function clearHistoryCursor(state: ChatState, sessionKey: string, agentId?: string): void {
  if (!state.chatMessagesBySession) {
    return;
  }
  const snapshot = readChatSessionSnapshot(state.chatMessagesBySession, state, {
    sessionKey,
    agentId,
  });
  if (snapshot?.deltaCursor === undefined) {
    return;
  }
  const { deltaCursor: _deltaCursor, ...withoutCursor } = snapshot;
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    withoutCursor,
  );
}
