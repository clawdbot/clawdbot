// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  disposeSelectedSessionMessageSubscription,
  syncSelectedSessionMessageSubscription,
} from "./chat-history-subscription.ts";
import type { ChatState } from "./chat-state-contract.ts";

const subscription = { key: "agent:main:main", agentId: null };

function createSubscriptionState(
  unsubscribeMessages: ReturnType<typeof vi.fn<SessionCapability["unsubscribeMessages"]>>,
  subscribeMessages: ReturnType<typeof vi.fn<SessionCapability["subscribeMessages"]>> = vi.fn<
    SessionCapability["subscribeMessages"]
  >(),
): ChatState {
  return {
    client: {} as GatewayBrowserClient,
    connected: true,
    connectionEpoch: 1,
    sessionKey: subscription.key,
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    hello: null,
    sessions: { subscribeMessages, unsubscribeMessages },
  };
}

describe("disposed chat message subscriptions", () => {
  afterEach(() => vi.useRealTimers());

  it("releases an active message subscription when its pane is disposed", () => {
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockResolvedValue(undefined);
    const state = createSubscriptionState(unsubscribeMessages);
    state.chatSessionMessageSubscriptionRequestedKey = subscription.key;
    state.chatSessionMessageSubscription = subscription;
    state.chatSessionApprovalQueue = [
      {
        id: "approval-1",
        kind: "plugin",
        request: { command: "Approve", sessionKey: subscription.key },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    ];

    disposeSelectedSessionMessageSubscription(state);

    expect(unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(subscription);
    expect(state.chatSessionMessageSubscriptionRequestedKey).toBeNull();
    expect(state.chatSessionMessageSubscription).toBeNull();
    expect(state.chatSessionApprovalQueue).toEqual([]);
  });

  it("releases a subscription that resolves after its pane is disposed", async () => {
    const pendingSubscription = createDeferred<typeof subscription>();
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockResolvedValue(undefined);
    const state = createSubscriptionState(
      unsubscribeMessages,
      vi.fn<SessionCapability["subscribeMessages"]>().mockReturnValue(pendingSubscription.promise),
    );

    const sync = syncSelectedSessionMessageSubscription(state as never);
    await Promise.resolve();
    disposeSelectedSessionMessageSubscription(state);
    pendingSubscription.resolve(subscription);
    await sync;

    expect(unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(subscription);
    expect(state.chatSessionMessageSubscription).toBeNull();
  });

  it("retries a temporary release failure without another pane synchronization", async () => {
    vi.useFakeTimers();
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockRejectedValueOnce(new Error("temporary observer release failure"))
      .mockResolvedValueOnce(undefined);
    const state = createSubscriptionState(unsubscribeMessages);
    state.chatSessionMessageSubscription = subscription;

    disposeSelectedSessionMessageSubscription(state);
    await vi.advanceTimersByTimeAsync(250);

    expect(unsubscribeMessages).toHaveBeenCalledTimes(2);
    expect(unsubscribeMessages).toHaveBeenLastCalledWith(subscription);
    expect(state.chatSessionMessageSubscription).toBeNull();
  });

  it("bounds permanently failing releases without leaking retry timers", async () => {
    vi.useFakeTimers();
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockRejectedValue(new Error("observer unavailable"));
    const state = createSubscriptionState(unsubscribeMessages);
    state.chatSessionMessageSubscription = subscription;

    disposeSelectedSessionMessageSubscription(state);
    await vi.runAllTimersAsync();

    expect(unsubscribeMessages).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.chatSessionMessageSubscription).toBeNull();
  });
});
