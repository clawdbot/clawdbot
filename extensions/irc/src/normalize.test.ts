import { describe, expect, it } from "vitest";
import {
  buildIrcAllowlistCandidates,
  normalizeIrcAllowEntry,
  normalizeIrcMessagingTarget,
  resolveIrcAllowlistMatch,
} from "./normalize.js";

describe("irc normalize", () => {
  it("normalizes targets", () => {
    expect(normalizeIrcMessagingTarget("irc:channel:openclaw")).toBe("#openclaw");
    expect(normalizeIrcMessagingTarget("user:alice")).toBe("alice");
    expect(normalizeIrcMessagingTarget("\n")).toBeUndefined();
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
    expect(
      resolveIrcAllowlistMatch({
        allowFrom: ["alice!ident@example.org"],
        message,
      }).allowed,
    ).toBe(true);
    expect(
      resolveIrcAllowlistMatch({
        allowFrom: ["alice"],
        message,
      }).allowed,
    ).toBe(false);
    expect(
      resolveIrcAllowlistMatch({
        allowFrom: ["alice"],
        message,
        allowNameMatching: true,
      }).allowed,
    ).toBe(true);
  });
});
