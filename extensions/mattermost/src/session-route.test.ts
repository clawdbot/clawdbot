import { describe, expect, it } from "vitest";
import { resolveMattermostOutboundSessionRoute } from "./session-route.js";

function expectRoute(route: ReturnType<typeof resolveMattermostOutboundSessionRoute>) {
  if (!route) {
    throw new Error("Expected Mattermost route");
  }
  return route;
}

describe("mattermost session route", () => {
  it("builds direct-message routes for user targets", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "@user123",
    });

    const directRoute = expectRoute(route);
    expect(directRoute.peer.kind).toBe("direct");
    expect(directRoute.peer.id).toBe("user123");
    expect(directRoute.from).toBe("mattermost:user123");
    expect(directRoute.to).toBe("user:user123");
  });

  it("builds threaded channel routes for channel targets", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:chan123",
      threadId: "thread456",
    });

    const channelRoute = expectRoute(route);
    expect(channelRoute.peer.kind).toBe("channel");
    expect(channelRoute.peer.id).toBe("chan123");
    expect(channelRoute.from).toBe("mattermost:channel:chan123");
    expect(channelRoute.to).toBe("channel:chan123");
    expect(channelRoute.threadId).toBe("thread456");
    expect(channelRoute.sessionKey).toContain("thread456");
  });

  it("recovers channel thread routes from currentSessionKey", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:chan123",
      currentSessionKey: "agent:main:mattermost:channel:chan123:thread:root-post",
    });

    const recoveredRoute = expectRoute(route);
    expect(recoveredRoute.sessionKey).toBe(
      "agent:main:mattermost:channel:chan123:thread:root-post",
    );
    expect(recoveredRoute.baseSessionKey).toBe("agent:main:mattermost:channel:chan123");
    expect(recoveredRoute.threadId).toBe("root-post");
  });

  it("keeps explicit replyToId ahead of recovered currentSessionKey thread", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:chan123",
      replyToId: "explicit-root",
      currentSessionKey: "agent:main:mattermost:channel:chan123:thread:root-post",
    });

    const replyRoute = expectRoute(route);
    expect(replyRoute.sessionKey).toBe(
      "agent:main:mattermost:channel:chan123:thread:explicit-root",
    );
    expect(replyRoute.threadId).toBe("explicit-root");
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "@user123",
      currentSessionKey: "agent:main:main:thread:root-post",
    });

    const dmRoute = expectRoute(route);
    expect(dmRoute.sessionKey).toBe("agent:main:main");
    expect(dmRoute.baseSessionKey).toBe("agent:main:main");
    expect(dmRoute.threadId).toBeUndefined();
  });

  it("returns null when the target is empty after normalization", () => {
    expect(
      resolveMattermostOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "acct-1",
        target: "mattermost:",
      }),
    ).toBeNull();
  });
});
