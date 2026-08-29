// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  disposeSelectedSessionMessageSubscription,
  syncSelectedSessionMessageSubscription,
} from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

type Subscription = { key: string; agentId: null };

function createSubscriptionState(options?: {
  previous?: Subscription;
  subscribeMessages?: ReturnType<typeof vi.fn<SessionCapability["subscribeMessages"]>>;
  unsubscribeMessages?: ReturnType<typeof vi.fn<SessionCapability["unsubscribeMessages"]>>;
}) {
  const selected = { key: "agent:main:selected", agentId: null } satisfies Subscription;
  const subscribeMessages =
    options?.subscribeMessages ??
    vi.fn<SessionCapability["subscribeMessages"]>(async () => selected);
  const unsubscribeMessages =
    options?.unsubscribeMessages ??
    vi.fn<SessionCapability["unsubscribeMessages"]>(async () => undefined);
  const state = {
    ...makeChatHost({ requestHandlers: {}, sessionKey: selected.key }),
    connectionEpoch: 1,
    chatError: null as string | null,
    sessionsError: null as string | null,
    chatSessionMessageSubscriptionRequestedKey: options?.previous?.key ?? null,
    chatSessionMessageSubscription: options?.previous ?? null,
    sessions: { subscribeMessages, unsubscribeMessages },
    requestUpdate: vi.fn(),
  } satisfies Parameters<typeof syncSelectedSessionMessageSubscription>[0];

  return { selected, state, subscribeMessages, unsubscribeMessages };
}

describe("visible chat message subscription failures", () => {
  it("shows a failed initial subscription in the existing chat error surface", async () => {
    const { state } = createSubscriptionState({
      subscribeMessages: vi
        .fn<SessionCapability["subscribeMessages"]>()
        .mockRejectedValue(new Error("Live messages unavailable")),
    });

    await syncSelectedSessionMessageSubscription(state);

    expect(state.chatSessionMessageSubscription).toBeNull();
    expect(state.sessionsError).toBe("Live messages unavailable");
    expect(state.lastError).toBe("Live messages unavailable");
    expect(state.chatError).toBe("Live messages unavailable");
    expect(state.requestUpdate).toHaveBeenCalledOnce();
  });

  it("shows a failed previous subscription release without losing its owned lease", async () => {
    const previous = { key: "agent:main:previous", agentId: null } satisfies Subscription;
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockRejectedValueOnce(new Error("Previous observer release failed"))
      .mockResolvedValueOnce(undefined);
    const { state } = createSubscriptionState({ previous, unsubscribeMessages });

    await syncSelectedSessionMessageSubscription(state);

    expect(state.chatSessionMessageSubscription).toBe(previous);
    expect(state.lastError).toBe("Previous observer release failed");
    expect(state.chatError).toBe(state.lastError);
    expect(state.requestUpdate).toHaveBeenCalledOnce();
  });

  it("keeps a dual-release warning until its exact previous lease is released", async () => {
    const previous = { key: "agent:main:previous", agentId: null } satisfies Subscription;
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockRejectedValueOnce(new Error("Previous observer release failed"))
      .mockRejectedValueOnce(new Error("Replacement observer release failed"))
      .mockRejectedValueOnce(new Error("Previous observer still unavailable"))
      .mockResolvedValueOnce(undefined);
    const { selected, state } = createSubscriptionState({ previous, unsubscribeMessages });

    await syncSelectedSessionMessageSubscription(state);

    const warning =
      "Previous observer release failed; replacement release failed: Replacement observer release failed";
    expect(state.chatSessionMessageSubscription).toEqual(selected);
    expect(state.lastError).toBe(warning);
    expect(state.chatError).toBe(warning);

    await syncSelectedSessionMessageSubscription(state);

    expect(state.lastError).toBe(warning);
    expect(state.chatError).toBe(warning);

    await syncSelectedSessionMessageSubscription(state);

    expect(state.chatSessionMessageSubscription).toEqual(selected);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(state.sessionsError).toBeNull();
    expect(unsubscribeMessages).toHaveBeenCalledTimes(4);
  });

  it("clears its own visible warning after the selected subscription recovers", async () => {
    const selected = { key: "agent:main:selected", agentId: null } satisfies Subscription;
    const subscribeMessages = vi
      .fn<SessionCapability["subscribeMessages"]>()
      .mockRejectedValueOnce(new Error("Live messages unavailable"))
      .mockResolvedValueOnce(selected);
    const { state } = createSubscriptionState({ subscribeMessages });

    await syncSelectedSessionMessageSubscription(state);
    expect(state.lastError).toBe("Live messages unavailable");

    await syncSelectedSessionMessageSubscription(state);

    expect(state.chatSessionMessageSubscription).toBe(selected);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(state.sessionsError).toBeNull();
  });

  it("never clears an unrelated chat failure published before subscription recovery", async () => {
    const selected = { key: "agent:main:selected", agentId: null } satisfies Subscription;
    const subscribeMessages = vi
      .fn<SessionCapability["subscribeMessages"]>()
      .mockRejectedValueOnce(new Error("Live messages unavailable"))
      .mockResolvedValueOnce(selected);
    const { state } = createSubscriptionState({ subscribeMessages });

    await syncSelectedSessionMessageSubscription(state);
    state.lastError = "Sending the message failed";
    state.chatError = "Sending the message failed";
    state.sessionsError = "Session list refresh failed";

    await syncSelectedSessionMessageSubscription(state);

    expect(state.lastError).toBe("Sending the message failed");
    expect(state.chatError).toBe("Sending the message failed");
    expect(state.sessionsError).toBe("Session list refresh failed");
  });

  it("never publishes a failed subscription after its pane is disposed", async () => {
    let rejectSubscription: (error: Error) => void = () => undefined;
    const pending = new Promise<Subscription>((_resolve, reject) => {
      rejectSubscription = reject;
    });
    const { state } = createSubscriptionState({
      subscribeMessages: vi.fn<SessionCapability["subscribeMessages"]>().mockReturnValue(pending),
    });

    const sync = syncSelectedSessionMessageSubscription(state);
    await Promise.resolve();
    disposeSelectedSessionMessageSubscription(state);
    rejectSubscription(new Error("Retired observer unavailable"));
    await sync;

    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(state.requestUpdate).not.toHaveBeenCalled();
  });

  it("never publishes a failed subscription from a replaced same-client generation", async () => {
    let rejectSubscription: (error: Error) => void = () => undefined;
    const pending = new Promise<Subscription>((_resolve, reject) => {
      rejectSubscription = reject;
    });
    const { state } = createSubscriptionState({
      subscribeMessages: vi.fn<SessionCapability["subscribeMessages"]>().mockReturnValue(pending),
    });

    const sync = syncSelectedSessionMessageSubscription(state);
    await Promise.resolve();
    state.connectionEpoch += 1;
    rejectSubscription(new Error("Prior connection generation unavailable"));
    await sync;

    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(state.requestUpdate).not.toHaveBeenCalled();
  });
});

describe("selected agent subscription changes", () => {
  it("clears stale approvals while switching the selected global agent", async () => {
    const previous = { key: "global", agentId: "main", includeApprovals: true as const };
    let resolveSubscribe!: (subscription: {
      key: string;
      agentId: string;
      includeApprovals: true;
      approvalReplay: { sessionKey: string; updatedAtMs: number; approvals: []; truncated: false };
    }) => void;
    const subscribeMessages = vi.fn(
      () =>
        new Promise<{
          key: string;
          agentId: string;
          includeApprovals: true;
          approvalReplay: {
            sessionKey: string;
            updatedAtMs: number;
            approvals: [];
            truncated: false;
          };
        }>((resolve) => {
          resolveSubscribe = resolve;
        }),
    );
    const state = {
      ...makeChatHost({ requestHandlers: {}, sessionKey: "global" }),
      assistantAgentId: "research",
      chatSessionMessageSubscriptionRequestedKey: "global",
      chatSessionMessageSubscription: previous,
      chatSessionApprovalQueue: [
        {
          id: "stale-main-approval",
          kind: "exec" as const,
          request: { command: "echo stale", agentId: "main", sessionKey: "global" },
          createdAtMs: 1,
          expiresAtMs: 10_000,
        },
      ],
      connectionEpoch: 1,
      sessions: {
        subscribeMessages,
        unsubscribeMessages: vi.fn(async () => undefined),
      },
      requestUpdate: vi.fn(),
    };

    const sync = syncSelectedSessionMessageSubscription(state as never);
    await Promise.resolve();
    const queueWhileReplacementIsPending = [...state.chatSessionApprovalQueue];
    resolveSubscribe({
      key: "global",
      agentId: "research",
      includeApprovals: true,
      approvalReplay: {
        sessionKey: "agent:research:global",
        updatedAtMs: 2,
        approvals: [],
        truncated: false,
      },
    });
    await sync;

    expect(queueWhileReplacementIsPending).toEqual([]);
    expect(subscribeMessages).toHaveBeenCalledWith("global", {
      agentId: "research",
      includeApprovals: true,
    });
  });

  it("keeps the latest selection when pending release retries settle out of order", async () => {
    const previous = { key: "agent:main:previous", agentId: null };
    let resolveSecondRetry: () => void = () => undefined;
    let resolveLatestRetry: () => void = () => undefined;
    const secondRetry = new Promise<void>((resolve) => {
      resolveSecondRetry = resolve;
    });
    const latestRetry = new Promise<void>((resolve) => {
      resolveLatestRetry = resolve;
    });
    const unsubscribeMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error("previous release failed"))
      .mockRejectedValueOnce(new Error("replacement release failed"))
      .mockReturnValueOnce(secondRetry)
      .mockReturnValueOnce(latestRetry)
      .mockResolvedValue(undefined);
    const subscribeMessages = vi.fn(async (key: string) => ({ key, agentId: null }));
    const state = {
      ...makeChatHost({ requestHandlers: {}, sessionKey: "agent:main:first" }),
      chatSessionMessageSubscriptionRequestedKey: previous.key,
      chatSessionMessageSubscription: previous,
      connectionEpoch: 1,
      sessions: { subscribeMessages, unsubscribeMessages },
      requestUpdate: vi.fn(),
    };
    await syncSelectedSessionMessageSubscription(state as never);

    state.sessionKey = "agent:main:second";
    const secondSync = syncSelectedSessionMessageSubscription(state as never);
    await Promise.resolve();
    state.sessionKey = "agent:main:latest";
    const latestSync = syncSelectedSessionMessageSubscription(state as never);
    await Promise.resolve();

    resolveLatestRetry();
    await latestSync;
    resolveSecondRetry();
    await secondSync;

    expect(state.chatSessionMessageSubscriptionRequestedKey).toBe("agent:main:latest");
    expect(state.chatSessionMessageSubscription).toEqual({
      key: "agent:main:latest",
      agentId: null,
    });
    expect(subscribeMessages).not.toHaveBeenCalledWith("agent:main:second", expect.anything());
  });
});
