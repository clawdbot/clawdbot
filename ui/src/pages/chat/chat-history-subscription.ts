import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { hasOperatorApprovalsAccess } from "../../app/operator-access.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { chatHistoryRequests, setChatError } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { projectSessionApprovalReplay } from "./session-approval-projection.ts";

const SESSION_MESSAGE_RELEASE_RETRY_MS = 250;

const MAX_SESSION_MESSAGE_RELEASE_ATTEMPTS = 3;

type ChatSessionMessageSubscriptionState = ChatState & {
  sessions: Pick<SessionCapability, "subscribeMessages" | "unsubscribeMessages">;
  sessionsError?: string | null;
};

function resolveSelectedGlobalAgentId(state: ChatSessionMessageSubscriptionState): string {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return resolveUiSelectedGlobalAgentId(state);
}

function resolveSelectedSessionMessageSubscriptionAgentId(
  state: ChatSessionMessageSubscriptionState,
  key: string,
): string | null {
  if (isUiGlobalSessionKey(key)) {
    return resolveSelectedGlobalAgentId(state);
  }
  return resolveUiGlobalAliasAgentId(state, key);
}

function isCurrentSelectedSessionMessageSubscriptionSync(
  state: ChatSessionMessageSubscriptionState,
  params: {
    generation: number;
    client: GatewayBrowserClient;
    connectionEpoch: number;
    requestedKey: string;
    requestedAgentId?: string | null;
  },
): boolean {
  return (
    chatHistoryRequests(state).subscriptionGeneration === params.generation &&
    state.client === params.client &&
    state.connectionEpoch === params.connectionEpoch &&
    state.connected &&
    state.sessionKey.trim() === params.requestedKey &&
    resolveSelectedSessionMessageSubscriptionAgentId(state, params.requestedKey) ===
      (params.requestedAgentId ?? null)
  );
}

async function retryPendingSessionMessageSubscriptionReleases(
  state: ChatSessionMessageSubscriptionState,
): Promise<void> {
  const pending = chatHistoryRequests(state).pendingSubscriptionReleases;
  if (pending.size === 0) {
    return;
  }
  await Promise.all(
    [...pending].map(async (subscription) => {
      try {
        await state.sessions.unsubscribeMessages(subscription);
        pending.delete(subscription);
      } catch {
        // Keep the handle for the next synchronization attempt or connection cleanup.
      }
    }),
  );
}

export function disposeSelectedSessionMessageSubscription(state: ChatState): void {
  const requests = chatHistoryRequests(state);
  requests.subscriptionGeneration += 1;
  const subscriptions = new Set(requests.pendingSubscriptionReleases);
  requests.pendingSubscriptionReleases.clear();
  if (state.chatSessionMessageSubscription) {
    subscriptions.add(state.chatSessionMessageSubscription);
  }
  state.chatSessionMessageSubscriptionRequestedKey = null;
  state.chatSessionMessageSubscription = null;
  state.chatSessionApprovalQueue = [];
  const sessions = state.sessions;
  if (!sessions?.unsubscribeMessages) {
    return;
  }
  const unsubscribeMessages = sessions.unsubscribeMessages.bind(sessions);
  for (const subscription of subscriptions) {
    // A detached pane cannot drain another queue. Retry on its longer-lived
    // session owner, but stop after terminal failures so timers cannot leak.
    void (async () => {
      let retryDelayMs = SESSION_MESSAGE_RELEASE_RETRY_MS;
      for (let attempt = 0; attempt < MAX_SESSION_MESSAGE_RELEASE_ATTEMPTS; attempt += 1) {
        try {
          await unsubscribeMessages(subscription);
          return;
        } catch {
          if (attempt + 1 === MAX_SESSION_MESSAGE_RELEASE_ATTEMPTS) {
            return;
          }
          await new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, retryDelayMs);
          });
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        }
      }
    })();
  }
}

export async function syncSelectedSessionMessageSubscription(
  state: ChatSessionMessageSubscriptionState,
  opts?: { force?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const nextKey = state.sessionKey.trim();
  if (!nextKey) {
    return;
  }
  const previousRequestedKey = normalizeNullableString(
    state.chatSessionMessageSubscriptionRequestedKey,
  );
  const previousSubscription = state.chatSessionMessageSubscription ?? null;
  const previousCanonicalKey = normalizeNullableString(previousSubscription?.key);
  const previousSelectedKey = previousRequestedKey ?? previousCanonicalKey;
  const nextSubscriptionAgentId = resolveSelectedSessionMessageSubscriptionAgentId(state, nextKey);
  const selectedAgentChanged =
    nextSubscriptionAgentId !== null &&
    previousSelectedKey === nextKey &&
    (previousSubscription?.agentId ?? null) !== nextSubscriptionAgentId;
  if (selectedAgentChanged) {
    state.chatSessionApprovalQueue = [];
    state.requestUpdate?.();
  }
  const paneRequests = chatHistoryRequests(state);
  const generation = ++paneRequests.subscriptionGeneration;
  await retryPendingSessionMessageSubscriptionReleases(state);
  const selectedKeyChanged = previousSelectedKey !== null && previousSelectedKey !== nextKey;
  const shouldUnsubscribePrevious =
    previousSubscription !== null &&
    (opts?.force === true || selectedKeyChanged || selectedAgentChanged);
  const shouldSubscribe =
    opts?.force === true ||
    selectedKeyChanged ||
    selectedAgentChanged ||
    previousCanonicalKey === null ||
    previousRequestedKey === null;
  const isCurrent = () =>
    isCurrentSelectedSessionMessageSubscriptionSync(state, {
      generation,
      client,
      connectionEpoch,
      requestedKey: nextKey,
      requestedAgentId: nextSubscriptionAgentId,
    });
  const clearRecoveredError = () => {
    const message = paneRequests.subscriptionError;
    if (!message || paneRequests.pendingSubscriptionReleases.size > 0) {
      return;
    }
    paneRequests.subscriptionError = undefined;
    for (const field of ["sessionsError", "lastError", "chatError"] as const) {
      if (state[field] === message) {
        state[field] = null;
      }
    }
    state.requestUpdate?.();
  };
  const publishError = (error: unknown) => {
    const message = formatUiError(error);
    paneRequests.subscriptionError = message;
    state.sessionsError = message;
    setChatError(state, message);
    state.requestUpdate?.();
  };
  if (!shouldUnsubscribePrevious && !shouldSubscribe) {
    if (
      isCurrent() &&
      previousSubscription &&
      areUiSessionKeysEquivalent(previousSubscription.key, nextKey) &&
      (previousSubscription.agentId ?? null) === nextSubscriptionAgentId
    ) {
      clearRecoveredError();
    }
    return;
  }
  try {
    let unsubscribePromise: Promise<void> = Promise.resolve();
    if (shouldUnsubscribePrevious && previousSubscription) {
      unsubscribePromise = state.sessions.unsubscribeMessages(previousSubscription);
    }
    const subscribePromise =
      shouldSubscribe && isCurrent()
        ? state.sessions.subscribeMessages(nextKey, {
            agentId: nextSubscriptionAgentId ?? undefined,
            ...(hasOperatorApprovalsAccess(state.hello?.auth ?? null)
              ? { includeApprovals: true }
              : {}),
          })
        : Promise.resolve(null);
    // Gateway subscriptions are independent canonical-key entries. Overlap the old
    // release with the new acquire so a session switch pays one RTT, not two.
    const [unsubscribeResult, subscribeResult] = await Promise.allSettled([
      unsubscribePromise,
      subscribePromise,
    ]);
    if (unsubscribeResult.status === "rejected") {
      if (subscribeResult.status === "fulfilled" && subscribeResult.value) {
        try {
          await state.sessions.unsubscribeMessages(subscribeResult.value);
        } catch (replacementReleaseError) {
          if (isCurrent()) {
            if (previousSubscription) {
              // Both live handles stay owned: the replacement becomes active while the
              // failed previous release remains queued until a later sync releases it.
              paneRequests.pendingSubscriptionReleases.add(previousSubscription);
            }
            state.chatSessionMessageSubscriptionRequestedKey = nextKey;
            state.chatSessionMessageSubscription = subscribeResult.value;
            publishError(
              `${formatUiError(unsubscribeResult.reason)}; replacement release failed: ${formatUiError(replacementReleaseError)}`,
            );
          } else {
            paneRequests.pendingSubscriptionReleases.add(subscribeResult.value);
          }
          return;
        }
      }
      if (isCurrent()) {
        publishError(unsubscribeResult.reason);
      }
      return;
    }
    if (subscribeResult.status === "rejected") {
      if (isCurrent() && shouldUnsubscribePrevious) {
        state.chatSessionMessageSubscriptionRequestedKey = null;
        state.chatSessionMessageSubscription = null;
      }
      throw subscribeResult.reason;
    }
    const subscribed = subscribeResult.value;
    if (!subscribed) {
      if (isCurrent() && shouldUnsubscribePrevious) {
        state.chatSessionMessageSubscriptionRequestedKey = null;
        state.chatSessionMessageSubscription = null;
      }
      return;
    }
    if (!isCurrent()) {
      // Generation advances before awaiting, so only the newest lease can reach assignment below.
      try {
        await state.sessions.unsubscribeMessages(subscribed);
      } catch {
        // A rejected release still owns its live Gateway observer; retain the
        // exact handle so the next sync can complete the original unsubscribe.
        paneRequests.pendingSubscriptionReleases.add(subscribed);
      }
      return;
    }
    state.chatSessionMessageSubscriptionRequestedKey = nextKey;
    state.chatSessionMessageSubscription = subscribed;
    if (subscribed.includeApprovals) {
      state.chatSessionApprovalQueue = projectSessionApprovalReplay(
        subscribed.approvalReplay,
        subscribed.key,
        subscribed.agentId ?? undefined,
      );
    } else {
      state.chatSessionApprovalQueue = [];
    }
    clearRecoveredError();
  } catch (err) {
    if (isCurrent()) {
      publishError(err);
    }
  }
}
