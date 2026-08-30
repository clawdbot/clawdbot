import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "../../test-support/monitor-route-test-support.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

const lifetimes: AbortController[] = [];
const roomId = "!room:example.org";

function receiver(
  accountId: string,
  options: {
    homeserver?: string;
    joined?: () => boolean;
    startupMs?: number;
    dropPreStartupMessages?: boolean;
    alreadyHandled?: boolean;
    directObservation?: boolean | "unknown";
    excludedBy?: "room" | "sender" | "group";
  } = {},
) {
  const lifetime = new AbortController();
  lifetimes.push(lifetime);
  const dispatch = vi.fn(async () => ({
    queuedFinal: false,
    counts: { final: 0, block: 0, tool: 0 },
  }));
  const commit = vi.fn(async () => true);
  const handledEvents = new Set<string>();
  const release = vi.fn();
  const membership = vi.fn(() => options.joined?.() ?? true);
  const harness = createMatrixHandlerTestHarness({
    accountId,
    startupMs: options.startupMs,
    dropPreStartupMessages: options.dropPreStartupMessages,
    participation: {
      homeserver: options.homeserver ?? "https://example.org",
      abortSignal: lifetime.signal,
      hasRecent: async ({ eventId }) =>
        options.alreadyHandled === true || handledEvents.has(eventId),
      observeDirectMessage: async () =>
        options.directObservation === "unknown" ? undefined : (options.directObservation ?? false),
    },
    isDirectMessage: false,
    roomsConfig: {
      "*": {
        autoReply: true,
        enabled: options.excludedBy !== "room",
        ...(options.excludedBy === "sender" ? { users: ["@other:example.org"] } : {}),
      },
    },
    ...(options.excludedBy === "group" ? { groupPolicy: "disabled" as const } : {}),
    mentionRegexes: [new RegExp(`@${accountId}:example\\.org`)],
    client: {
      getUserId: async () => `@${accountId}:example.org`,
      hasSyncedJoinedRoomMember: membership,
      isSyncedUnencryptedRoom: async () => true,
    },
    resolveAgentRoute: () => ({
      agentId: accountId,
      channel: "matrix",
      accountId,
      sessionKey: `agent:${accountId}:matrix:room`,
      mainSessionKey: `agent:${accountId}:main`,
      matchedBy: "binding.account",
    }),
    inboundDeduper: {
      claim: async ({ eventId }) => ({
        kind: "claimed",
        handle: {
          keys: [eventId],
          commit: async () => {
            handledEvents.add(eventId);
            return await commit();
          },
          release,
        },
      }),
    },
    dispatchInboundMessage: dispatch,
  });
  return { ...harness, dispatch, commit, release, membership, lifetime };
}

function installPolicy(handler = vi.fn().mockResolvedValue({ accountIds: ["alice"] })) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_channel_participation", handler }]),
  );
  return handler;
}

beforeEach(() => installMatrixMonitorTestRuntime());
afterEach(() => {
  for (const lifetime of lifetimes.splice(0)) {
    lifetime.abort();
  }
  resetGlobalHookRunner();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

describe("Matrix participation at admitted ingress", () => {
  it("uses one closed-roster decision even when sibling delivery arrives later", async () => {
    const policy = installPolicy();
    const alice = receiver("alice");
    const bob = receiver("bob");
    const event = createMatrixTextMessageEvent({ eventId: "$shared", body: "Who can help?" });

    await alice.handler(roomId, event);
    await bob.handler(roomId, event);

    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy.mock.calls[0]?.[0]).toMatchObject({
      message: "Who can help?",
      candidates: [{ accountId: "alice" }, { accountId: "bob" }],
    });
    expect(alice.dispatch).toHaveBeenCalledTimes(1);
    expect(bob.dispatch).not.toHaveBeenCalled();
    expect(bob.recordInboundSession).not.toHaveBeenCalled();
    expect(bob.commit).toHaveBeenCalledTimes(1);
    expect(bob.release).not.toHaveBeenCalled();
  });

  it("leaves ordinary handlers untouched when no participation policy is enabled", async () => {
    const alice = receiver("alice");
    const bob = receiver("bob");
    const event = createMatrixTextMessageEvent({ eventId: "$disabled", body: "Who can help?" });

    await Promise.all([alice.handler(roomId, event), bob.handler(roomId, event)]);

    expect(alice.dispatch).toHaveBeenCalledTimes(1);
    expect(bob.dispatch).toHaveBeenCalledTimes(1);
    expect(alice.membership).not.toHaveBeenCalled();
    expect(bob.membership).not.toHaveBeenCalled();
  });

  it.each(["alice", "outsider"])(
    "preserves explicit addressing to %s without classification",
    async (target) => {
      const policy = installPolicy();
      const alice = receiver("alice");
      const bob = receiver("bob");
      const event = createMatrixTextMessageEvent({
        eventId: "$addressed",
        body: `@${target}:example.org can you help?`,
        mentions: { user_ids: [`@${target}:example.org`] },
      });

      await Promise.all([alice.handler(roomId, event), bob.handler(roomId, event)]);

      expect(policy).not.toHaveBeenCalled();
      expect(alice.dispatch).toHaveBeenCalledTimes(1);
      expect(bob.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves legacy formatted targeting outside the eligible roster", async () => {
    const policy = installPolicy();
    const alice = receiver("alice");
    const bob = receiver("bob");
    const event = createMatrixRoomMessageEvent({
      eventId: "$formatted-target",
      content: {
        msgtype: "m.text",
        body: "Outsider, can you help?",
        format: "org.matrix.custom.html",
        formatted_body:
          '<a href="https://matrix.to/#/@outsider:example.org">Outsider</a>, can you help?',
      },
    });
    await Promise.all([alice.handler(roomId, event), bob.handler(roomId, event)]);
    expect(policy).not.toHaveBeenCalled();
    expect(alice.dispatch).toHaveBeenCalledTimes(1);
    expect(bob.dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves textual addressing to a bound receiver outside the eligible roster", async () => {
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "alice",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === roomId
          ? {
              bindingId: "alice-bound",
              targetSessionKey: "agent:alice:bound-session",
              targetKind: "session",
              conversation: { channel: "matrix", accountId: "alice", conversationId: roomId },
              status: "active",
              boundAt: Date.now(),
              metadata: { boundBy: "user" },
            }
          : null,
      touch: vi.fn(),
    });
    const policy = installPolicy(vi.fn().mockResolvedValue({ accountIds: ["carol"] }));
    receiver("alice");
    const bob = receiver("bob");
    receiver("carol");

    await bob.handler(
      roomId,
      createMatrixTextMessageEvent({ eventId: "$bound-target", body: "@alice:example.org help?" }),
    );

    expect(policy).not.toHaveBeenCalled();
    expect(bob.dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves ordinary delivery when a sibling cannot observe its DM classification", async () => {
    const policy = installPolicy(vi.fn().mockResolvedValue({ accountIds: ["carol"] }));
    receiver("alice", { directObservation: "unknown" });
    const bob = receiver("bob");
    receiver("carol");

    await bob.handler(
      roomId,
      createMatrixTextMessageEvent({ eventId: "$unknown-dm", body: "Who can help?" }),
    );

    expect(policy).not.toHaveBeenCalled();
    expect(bob.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["room", "sender", "group"] as const)(
    "preserves textual addressing to a receiver excluded by %s policy",
    async (excludedBy) => {
      const policy = installPolicy(vi.fn().mockResolvedValue({ accountIds: ["carol"] }));
      receiver("alice", { excludedBy });
      const bob = receiver("bob");
      receiver("carol");

      await bob.handler(
        roomId,
        createMatrixTextMessageEvent({
          eventId: "$excluded-target",
          body: "@alice:example.org help?",
        }),
      );

      expect(policy).not.toHaveBeenCalled();
      expect(bob.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it("does not suppress for a selected sibling that leaves during classification", async () => {
    let finish!: (value: { accountIds: string[] }) => void;
    const policy = installPolicy(
      vi
        .fn()
        .mockImplementation(
          () => new Promise<{ accountIds: string[] }>((resolve) => (finish = resolve)),
        ),
    );
    let joined = true;
    receiver("alice", { joined: () => joined });
    const bob = receiver("bob");
    const pending = bob.handler(
      roomId,
      createMatrixTextMessageEvent({ eventId: "$left", body: "Who can help?" }),
    );
    await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(1));
    joined = false;
    finish({ accountIds: ["alice"] });
    await pending;

    expect(bob.dispatch).toHaveBeenCalledTimes(1);
    expect(bob.commit).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "honors sibling startup gating when dropPreStartupMessages=%s",
    async (dropPreStartupMessages) => {
      const policy = installPolicy();
      receiver("alice", { startupMs: Date.now() + 60_000, dropPreStartupMessages });
      const bob = receiver("bob");

      await bob.handler(
        roomId,
        createMatrixTextMessageEvent({ eventId: "$before-alice-started", body: "Who can help?" }),
      );

      expect(policy).toHaveBeenCalledTimes(dropPreStartupMessages ? 0 : 1);
      expect(bob.dispatch).toHaveBeenCalledTimes(dropPreStartupMessages ? 1 : 0);
    },
  );

  it("does not select a sibling whose replay owner already consumed the event", async () => {
    const policy = installPolicy();
    receiver("alice", { alreadyHandled: true });
    const bob = receiver("bob");

    await bob.handler(
      roomId,
      createMatrixTextMessageEvent({ eventId: "$previously-consumed", body: "Who can help?" }),
    );

    expect(policy).not.toHaveBeenCalled();
    expect(bob.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not combine candidates or native event identities across homeservers", async () => {
    const policy = installPolicy(
      vi.fn().mockImplementation(async (event: { candidates: { accountId: string }[] }) => ({
        accountIds: event.candidates.slice(0, 1).map(({ accountId }) => accountId),
      })),
    );
    receiver("alice");
    const bob = receiver("bob");
    receiver("carol", { homeserver: "https://other.example.org" });
    const dave = receiver("dave", { homeserver: "https://other.example.org" });
    const event = createMatrixTextMessageEvent({ eventId: "$same-id", body: "Who can help?" });

    await Promise.all([bob.handler(roomId, event), dave.handler(roomId, event)]);

    expect(policy).toHaveBeenCalledTimes(2);
    expect(
      policy.mock.calls.map(([input]) =>
        input.candidates.map((candidate: { accountId: string }) => candidate.accountId),
      ),
    ).toEqual([
      ["alice", "bob"],
      ["carol", "dave"],
    ]);
    expect(bob.dispatch).not.toHaveBeenCalled();
    expect(dave.dispatch).not.toHaveBeenCalled();
  });
});
