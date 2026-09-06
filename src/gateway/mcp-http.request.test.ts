import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type McpLoopbackRequestContext,
  resolveMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { resolveMcpRequestContext } from "./mcp-http.request.js";

// A request may carry spoofable delivery headers, but the routable messaging
// target is a server-minted authority. Build a request whose headers try to
// override it and prove the bound value always wins / stays closed.
function reqWithSpoofedTarget(): IncomingMessage {
  return {
    headers: {
      "x-openclaw-current-channel-id": "attacker-channel",
      "x-openclaw-current-messaging-target": "attacker:target",
    },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("resolveMcpRequestContext currentMessagingTarget authority", () => {
  it("keeps the bound-context routable target; a spoofed header cannot override it", () => {
    const context: McpLoopbackRequestContext = {
      sessionKey: "agent:main:slack:dm:U123",
      senderIsOwner: true,
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
    };
    // The Gateway-minted client grant is the only carrier of a bound routable
    // target. resolveMcpRequestContext returns the grant context verbatim on
    // this path and never reads request headers, so a minimal grant stub proves
    // the authority: the bound value wins and the spoofed header stays inert.
    const boundClientGrant = {
      context,
    } as NonNullable<ReturnType<typeof resolveMcpLoopbackClientGrant>>;
    const ctx = resolveMcpRequestContext(reqWithSpoofedTarget(), {} as OpenClawConfig, {
      senderIsOwner: true,
      boundClientGrant,
    });
    expect(ctx.currentMessagingTarget).toBe("user:U123");
    expect(ctx.currentChannelId).toBe("D123");
  });

  it("fails closed for grant-authenticated callers: no routable target from headers", () => {
    const ctx = resolveMcpRequestContext(reqWithSpoofedTarget(), {} as OpenClawConfig, {
      senderIsOwner: false,
      boundSessionKey: "agent:main:slack:dm:U123",
    });
    expect(ctx.currentMessagingTarget).toBeUndefined();
    expect(ctx.currentChannelId).toBeUndefined();
  });

  it("never sources the routable target from a header on the token-authenticated path", () => {
    // The header path is the one branch that does read request headers, so it is
    // where a spoof would land. It reads currentChannelId (proving headers reach
    // here) but has no x-openclaw-current-messaging-target reader at all, so the
    // routable target stays undefined regardless of what the caller sends.
    const req = {
      headers: {
        "x-session-key": "agent:main:slack:dm:U123",
        "x-openclaw-current-channel-id": "attacker-channel",
        "x-openclaw-current-messaging-target": "attacker:target",
      },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    const ctx = resolveMcpRequestContext(req, {} as OpenClawConfig, { senderIsOwner: true });
    expect(ctx.currentChannelId).toBe("attacker-channel");
    expect(ctx.currentMessagingTarget).toBeUndefined();
  });
});
