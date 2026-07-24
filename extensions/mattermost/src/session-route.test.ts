// Mattermost tests cover session route plugin behavior.
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
    expect(directRoute.recipientSessionExact).toBe(false);
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
    expect(channelRoute.recipientSessionExact).toBe(false);
  });

  it("accepts canonical user ids but keeps channel-shaped ids inexact", () => {
    const id = "abcdefghijklmnopqrstuvwxyz";
    const bareRoute = expectRoute(
      resolveMattermostOutboundSessionRoute({ cfg: {}, agentId: "main", target: id }),
    );
    const userRoute = expectRoute(
      resolveMattermostOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        target: `user:${id}`,
      }),
    );
    const channelRoute = expectRoute(
      resolveMattermostOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        target: `channel:${id}`,
      }),
    );

    expect(bareRoute.recipientSessionExact).toBe(false);
    expect(userRoute.recipientSessionExact).toBe(true);
    expect(channelRoute.recipientSessionExact).toBe(false);
  });

  it.each(["channel", "group"] as const)(
    "does not treat directory-resolved %s ids as classified channel types",
    (kind) => {
      const id = "abcdefghijklmnopqrstuvwxyz";
      const route = expectRoute(
        resolveMattermostOutboundSessionRoute({
          cfg: {},
          agentId: "main",
          target: `channel:${id}`,
          resolvedTarget: {
            to: `channel:${id}`,
            kind,
            source: "directory",
          },
        }),
      );

      expect(route.recipientSessionExact).toBe(false);
    },
  );

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

  it("keys a private channel as group when the resolved target kind is group", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:priv123",
      resolvedTarget: {
        to: "channel:priv123",
        kind: "group",
        source: "directory",
      },
    });

    const groupRoute = expectRoute(route);
    expect(groupRoute.peer.kind).toBe("group");
    expect(groupRoute.peer.id).toBe("priv123");
    expect(groupRoute.chatType).toBe("group");
    expect(groupRoute.baseSessionKey).toBe("agent:main:mattermost:group:priv123");
    // Wire target stays channel:<id>; the group distinction lives in the session key.
    expect(groupRoute.to).toBe("channel:priv123");
  });

  it("keys a private channel as group from the inbound currentSessionKey", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:priv123",
      currentSessionKey: "agent:main:mattermost:group:priv123:thread:root-post",
    });

    const groupRoute = expectRoute(route);
    expect(groupRoute.peer.kind).toBe("group");
    expect(groupRoute.chatType).toBe("group");
    // Outbound now shares the inbound group:<id> namespace instead of forking channel:<id>.
    expect(groupRoute.sessionKey).toBe("agent:main:mattermost:group:priv123:thread:root-post");
    expect(groupRoute.threadId).toBe("root-post");
  });

  it("keeps a public channel as channel when an unrelated group session key exists", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:pub999",
      // A group session key for a DIFFERENT peer must not leak onto this channel.
      currentSessionKey: "agent:main:mattermost:group:priv123:thread:root-post",
    });

    const channelRoute = expectRoute(route);
    expect(channelRoute.peer.kind).toBe("channel");
    expect(channelRoute.chatType).toBe("channel");
    expect(channelRoute.baseSessionKey).toBe("agent:main:mattermost:channel:pub999");
  });

  it("ignores a non-canonical session key containing an embedded Mattermost route", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "mattermost:channel:priv123",
      currentSessionKey: "agent:main:other:group:peer:mattermost:group:priv123:thread:root-post",
    });

    expect(expectRoute(route).peer.kind).toBe("channel");
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
