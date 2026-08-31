import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import {
  isRetryableStartupUnavailable,
  resolveStartupRetryDelayMs,
  sleep,
} from "./chat-history-retry.ts";
import {
  type ChatHistoryResult,
  type ChatHistoryDeltaResult,
  type ChatHistoryResetResult,
  type ChatHistoryResponse,
  isHistoryCursor,
  resolveChatHistoryPagination,
  historySessionId,
} from "./chat-history-snapshot.ts";
import {
  chatHistoryRequests,
  beginHistoryRequest,
  acceptsHistoryResult,
} from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";

export const CHAT_HISTORY_REQUEST_LIMIT = 800;

// Back-scroll pages are larger than the startup tail: session open stays cheap
// while older-history reads amortize round trips and prepend/re-anchor cycles.
// The gateway independently bounds each response (entry cap + byte budget).
const CHAT_HISTORY_OLDER_PAGE_LIMIT = 1000;

const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;

type SharedChatHistoryResponse = ChatHistoryResponse & {
  sourceCanonicalListRevision?: number;
};

type SharedChatHistoryRequest = {
  consumers: Set<SharedChatHistoryConsumer>;
  promise: Promise<SharedChatHistoryResponse>;
};

type SharedChatHistoryRegistry = {
  ownerRequestCounts: WeakMap<object, Map<string, number>>;
  requests: Map<string, SharedChatHistoryRequest>;
};

type SharedChatHistoryConsumer = {
  isCurrent: () => boolean;
  retryDeadlineMs: number;
};

const sharedChatHistoryRequests = new WeakMap<GatewayBrowserClient, SharedChatHistoryRegistry>();

function updateChatHistoryOwnerRequestCount(
  registry: SharedChatHistoryRegistry,
  owner: object,
  requestKey: string,
  delta: 1 | -1,
) {
  let counts = registry.ownerRequestCounts.get(owner);
  const nextCount = (counts?.get(requestKey) ?? 0) + delta;
  if (nextCount <= 0) {
    counts?.delete(requestKey);
    if (counts?.size === 0) {
      registry.ownerRequestCounts.delete(owner);
    }
    return;
  }
  if (!counts) {
    counts = new Map();
    registry.ownerRequestCounts.set(owner, counts);
  }
  counts.set(requestKey, nextCount);
}

async function requestChatHistory(
  client: GatewayBrowserClient,
  method: "chat.history" | "chat.startup",
  sessionKey: string,
  requestAgentId: string | undefined,
  shouldContinue: () => boolean,
  shouldRetry: () => boolean,
  cursor?: string,
  inputRunIds: string[] = [],
): Promise<ChatHistoryResponse> {
  for (;;) {
    try {
      return await client.request<ChatHistoryResponse>(method, {
        sessionKey,
        ...(requestAgentId ? { agentId: requestAgentId } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        limit: CHAT_HISTORY_REQUEST_LIMIT,
        ...(inputRunIds.length ? { inputRunIds } : {}),
      });
    } catch (err) {
      if (!shouldContinue()) {
        throw err;
      }
      if (shouldRetry() && isRetryableStartupUnavailable(err, method)) {
        await sleep(resolveStartupRetryDelayMs(err));
        if (!shouldContinue()) {
          throw err;
        }
        continue;
      }
      throw err;
    }
  }
}

export function requestSharedHistory(
  client: GatewayBrowserClient,
  requestKey: string,
  method: "chat.history" | "chat.startup",
  sessionKey: string,
  requestAgentId: string | undefined,
  consumerOwner: object,
  isCurrentConsumer: () => boolean,
  cursor?: string,
  sourceCanonicalListRevision?: number,
  inputRunIds?: string[],
): Promise<SharedChatHistoryResponse> {
  let registry = sharedChatHistoryRequests.get(client);
  if (!registry) {
    registry = {
      ownerRequestCounts: new WeakMap(),
      requests: new Map(),
    };
    sharedChatHistoryRequests.set(client, registry);
  }
  const requests = registry.requests;
  let shared = requests.get(requestKey);
  const existingOwner = (registry.ownerRequestCounts.get(consumerOwner)?.get(requestKey) ?? 0) > 0;
  const consumer = {
    isCurrent: isCurrentConsumer,
    retryDeadlineMs: Date.now() + STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS,
  };
  if (!shared || existingOwner) {
    const consumers = new Set([consumer]);
    const shouldContinue = () => [...consumers].some((entry) => entry.isCurrent());
    // A pane joining older shared work still owns a full retry window. Otherwise
    // it could inherit the first consumer's nearly expired startup deadline.
    const shouldRetry = () =>
      [...consumers].some((entry) => entry.isCurrent() && Date.now() < entry.retryDeadlineMs);
    const promise = requestChatHistory(
      client,
      method,
      sessionKey,
      requestAgentId,
      shouldContinue,
      shouldRetry,
      cursor,
      inputRunIds,
    )
      .then((response) => ({ ...response, sourceCanonicalListRevision }))
      .finally(() => {
        if (requests?.get(requestKey)?.promise === promise) {
          requests.delete(requestKey);
        }
      });
    shared = { consumers, promise };
    requests.set(requestKey, shared);
  } else {
    shared.consumers.add(consumer);
  }
  updateChatHistoryOwnerRequestCount(registry, consumerOwner, requestKey, 1);
  // The client owns this bounded in-flight map, while every pane remains responsible
  // for applying the shared payload under its own session/version ownership checks.
  // Owner counts outlive displaced map entries so overlapping refreshes never reuse stale work.
  return shared.promise.finally(() => {
    shared?.consumers.delete(consumer);
    updateChatHistoryOwnerRequestCount(registry, consumerOwner, requestKey, -1);
  });
}

type ChatSessionSnapshotRequestResult =
  | { kind: "snapshot"; snapshot: ChatSessionSnapshot }
  | ChatHistoryDeltaResult
  | ChatHistoryResetResult;

export async function requestChatSessionSnapshot(
  client: GatewayBrowserClient,
  sessionKey: string,
  consumerOwner: object,
  isCurrentConsumer: () => boolean,
  cursor?: string,
): Promise<ChatSessionSnapshotRequestResult> {
  const method = "chat.history";
  const requestModeKey = cursor === undefined ? "page" : `cursor:${cursor}`;
  const requestKey = `prefetch\u0000${method}\u0000${sessionKey}\u0000${CHAT_HISTORY_REQUEST_LIMIT}\u0000${requestModeKey}`;
  const result = await requestSharedHistory(
    client,
    requestKey,
    method,
    sessionKey,
    undefined,
    consumerOwner,
    isCurrentConsumer,
    cursor,
  );
  if (isHistoryCursor(result)) {
    return result;
  }
  const sessionInfo = result.sessionInfo;
  return {
    kind: "snapshot",
    snapshot: {
      ...(result.deltaCursor !== undefined ? { deltaCursor: result.deltaCursor } : {}),
      ...(Object.hasOwn(sessionInfo ?? {}, "activeLeafEntryId")
        ? { displayedLeafEntryId: sessionInfo?.activeLeafEntryId?.trim() || null }
        : {}),
      messages: visibleChatHistoryMessages(result.messages),
      pagination: resolveChatHistoryPagination(result),
      sessionId: historySessionId(result),
    },
  };
}

async function requestOlderChatHistoryPage(
  client: GatewayBrowserClient,
  sessionKey: string,
  requestAgentId: string | undefined,
  offset: number,
): Promise<ChatHistoryResult> {
  const result = await client.request<ChatHistoryResult>("chat.history", {
    sessionKey,
    ...(requestAgentId ? { agentId: requestAgentId } : {}),
    limit: CHAT_HISTORY_OLDER_PAGE_LIMIT,
    offset,
  });
  return {
    ...result,
    messages: visibleChatHistoryMessages(result.messages),
  };
}

export async function loadOlderChatHistoryPage(
  state: ChatState,
  offset: number,
): Promise<ChatHistoryResult | undefined> {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const client = state.client;
  const sessionKey = state.sessionKey;
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const ownership = beginHistoryRequest(
    state,
    client,
    state.connectionEpoch,
    sessionKey,
    requestAgentId,
  );
  const result = await requestOlderChatHistoryPage(client, sessionKey, requestAgentId, offset);
  if (!acceptsHistoryResult(state, ownership)) {
    return undefined;
  }
  return result;
}

export type StagedOlderHistoryPage = {
  claim: {
    client: GatewayBrowserClient;
    connectionEpoch: number;
    sessionKey: string;
    agentId?: string;
    /** Projection fence: any later history request or reset (tail reload,
     * rewind, branch switch) advances the version and voids this page even
     * when the replacement projection lands on the same cursor. */
    historyVersion: number;
  };
  requestedOffset: number;
  result: ChatHistoryResult;
};

// The staged prefetch deliberately skips beginHistoryRequest: request
// ownership is last-writer-wins, so a background fetch bumping the version
// could invalidate a concurrent tail load's apply. The claim below carries the
// same facts and the pane validates it at consume time instead.
export async function fetchStagedOlderHistoryPage(
  state: ChatState,
  offset: number,
): Promise<StagedOlderHistoryPage | undefined> {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const sessionKey = state.sessionKey;
  const historyVersion = chatHistoryRequests(state).historyVersion;
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const result = await requestOlderChatHistoryPage(client, sessionKey, requestAgentId, offset);
  return {
    claim: {
      client,
      connectionEpoch,
      sessionKey,
      historyVersion,
      ...(requestAgentId ? { agentId: requestAgentId } : {}),
    },
    requestedOffset: offset,
    result,
  };
}

/** A staged page is valid only for the exact connection, session, and the
 * pagination cursor it was fetched at; any drift means the reactive path must
 * refetch (tail reloads rebase offsets, resets reuse session keys). */
export function isStagedOlderHistoryPageCurrent(
  state: ChatState,
  staged: StagedOlderHistoryPage,
): boolean {
  const claim = staged.claim;
  const pagination = state.chatHistoryPagination;
  return (
    state.client === claim.client &&
    state.connected &&
    state.connectionEpoch === claim.connectionEpoch &&
    chatHistoryRequests(state).historyVersion === claim.historyVersion &&
    state.sessionKey === claim.sessionKey &&
    (!isUiSelectedGlobalSessionKey(state, claim.sessionKey) ||
      resolveUiSelectedSessionAgentId(state) === claim.agentId) &&
    pagination.hasMore &&
    pagination.nextOffset === staged.requestedOffset
  );
}
