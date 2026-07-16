import { describe, expect, it } from "vitest";
import { resolveIrcInboundTarget } from "./monitor.js";

describe("irc monitor inbound target", () => {
  it("keeps channel target for group messages", () => {
    expect(
      resolveIrcInboundTarget({
        target: "#openclaw",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: true,
      target: "#openclaw",
      rawTarget: "#openclaw",
    });
  });

  it("maps DM target to sender nick and preserves raw target", () => {
    expect(
      resolveIrcInboundTarget({
        target: "openclaw-bot",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: false,
      target: "alice",
      rawTarget: "openclaw-bot",
    });
  });

  it("falls back to raw target when sender nick is empty", () => {
    expect(
      resolveIrcInboundTarget({
        target: "openclaw-bot",
        senderNick: " ",
      }),
    ).toEqual({
      isGroup: false,
      target: "openclaw-bot",
      rawTarget: "openclaw-bot",
    });
  });
});
