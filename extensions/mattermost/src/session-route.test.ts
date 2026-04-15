import { describe, expect, it } from "vitest";
import { resolveMattermostOutboundSessionRoute } from "./session-route.js";

describe("mattermost session route", () => {
  it("builds direct-message routes for user targets", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "@user123",
    });

    expect(route).toMatchObject({
      peer: {
        kind: "direct",
        id: "user123",
      },
      from: "mattermost:user123",
      to: "user:user123",
    });
  });

  it("builds threaded channel routes for channel targets", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:chan123",
      threadId: "thread456",
    });

    expect(route).toMatchObject({
      peer: {
        kind: "channel",
        id: "chan123",
      },
      from: "mattermost:channel:chan123",
      to: "channel:chan123",
      threadId: "thread456",
    });
    expect(route?.sessionKey).toContain("thread456");
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
