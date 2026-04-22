import { describe, expect, it } from "vitest";
import {
  buildThreadAwareOutboundSessionRoute,
  recoverCurrentThreadSessionId,
  type ChannelOutboundSessionRoute,
} from "./core.js";

function baseRoute(
  overrides: Partial<ChannelOutboundSessionRoute> = {},
): ChannelOutboundSessionRoute {
  return {
    sessionKey: "agent:main:workspace:channel:c123",
    baseSessionKey: "agent:main:workspace:channel:c123",
    peer: { kind: "channel", id: "c123" },
    chatType: "channel",
    from: "workspace:channel:c123",
    to: "channel:c123",
    ...overrides,
  };
}

describe("buildThreadAwareOutboundSessionRoute", () => {
  it("uses replyToId before threadId and recovered current-session thread by default", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      replyToId: "reply-1",
      threadId: "thread-1",
      currentSessionKey: "agent:main:workspace:channel:c123:thread:current-1",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:workspace:channel:c123:thread:reply-1",
      threadId: "reply-1",
    });
  });

  it("supports provider-specific threadId-first precedence", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      replyToId: "reply-1",
      threadId: "thread-1",
      precedence: ["threadId", "replyToId", "currentSession"],
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:workspace:channel:c123:thread:thread-1",
      threadId: "thread-1",
    });
  });

  it("keeps numeric delivery thread ids on the route while stringifying the session suffix", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      threadId: 99,
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:workspace:channel:c123:thread:99",
      threadId: 99,
    });
  });

  it("recovers a current-session thread only when the base session matches", () => {
    expect(
      recoverCurrentThreadSessionId({
        route: baseRoute(),
        currentSessionKey: "agent:main:workspace:channel:c123:thread:current-1",
      }),
    ).toBe("current-1");
    expect(
      recoverCurrentThreadSessionId({
        route: baseRoute(),
        currentSessionKey: "agent:main:workspace:channel:other:thread:current-1",
      }),
    ).toBeUndefined();
  });

  it("lets providers veto current-session recovery", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      currentSessionKey: "agent:main:workspace:channel:c123:thread:current-1",
      canRecoverCurrentThread: () => false,
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:workspace:channel:c123",
    });
    expect(route.threadId).toBeUndefined();
  });

  it("preserves provider-specific thread case when requested", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      threadId: "$EventID:Example.Org",
      normalizeThreadId: (threadId) => threadId,
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:workspace:channel:c123:thread:$EventID:Example.Org",
      threadId: "$EventID:Example.Org",
    });
  });

  it("can carry a delivery thread without adding a session suffix", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      threadId: "thread-1",
      useSuffix: false,
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:workspace:channel:c123",
      threadId: "thread-1",
    });
  });
});
