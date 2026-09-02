// Irc tests cover normalize plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildIrcAllowlistCandidates,
  normalizeIrcAllowEntry,
  normalizeIrcMessagingTarget,
  resolveIrcOutboundSessionRoute,
} from "./normalize.js";

describe("irc normalize", () => {
  it("normalizes targets", () => {
    expect(normalizeIrcMessagingTarget("irc:channel:openclaw")).toBe("#openclaw");
    expect(normalizeIrcMessagingTarget("user:alice")).toBe("alice");
    expect(normalizeIrcMessagingTarget("\n")).toBeUndefined();
  });

  it("builds canonical channel and direct session routes", () => {
    const cfg = { session: { dmScope: "per-channel-peer" as const } };
    expect(
      resolveIrcOutboundSessionRoute({
        cfg,
        agentId: "main",
        target: "irc:channel:openclaw",
      }),
    ).toMatchObject({
      sessionKey: "agent:main:irc:group:#openclaw",
      peer: { kind: "group", id: "#openclaw" },
      chatType: "group",
      recipientSessionExact: false,
      to: "#openclaw",
    });
    expect(
      resolveIrcOutboundSessionRoute({ cfg, agentId: "main", target: "user:alice" }),
    ).toMatchObject({
      sessionKey: "agent:main:irc:direct:alice",
      peer: { kind: "direct", id: "alice" },
      chatType: "direct",
      recipientSessionExact: "direct-alias",
      to: "alice",
    });
    expect(resolveIrcOutboundSessionRoute({ cfg, agentId: "main", target: "\n" })).toBeNull();
  });

  it("collapses direct aliases to the configured shared main session", () => {
    expect(
      resolveIrcOutboundSessionRoute({
        cfg: { session: { dmScope: "main", mainKey: "work" } },
        agentId: "ops",
        target: "user:alice",
      }),
    ).toMatchObject({
      sessionKey: "agent:ops:work",
      baseSessionKey: "agent:ops:work",
      recipientSessionExact: "direct-alias",
      chatType: "direct",
    });
  });

  it("normalizes allowlist entries", () => {
    expect(normalizeIrcAllowEntry("IRC:User:Alice!u@h")).toBe("alice!u@h");
  });

  it("matches senders by nick/user/host candidates", () => {
    const message = {
      messageId: "m1",
      target: "#chan",
      senderNick: "Alice",
      senderUser: "ident",
      senderHost: "example.org",
      text: "hi",
      timestamp: Date.now(),
      isGroup: true,
    };

    expect(buildIrcAllowlistCandidates(message)).toContain("alice!ident@example.org");
    expect(buildIrcAllowlistCandidates(message)).not.toContain("alice");
    expect(buildIrcAllowlistCandidates(message, { allowNameMatching: true })).toContain("alice");
  });
});
