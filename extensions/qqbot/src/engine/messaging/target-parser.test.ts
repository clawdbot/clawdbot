import { describe, expect, it } from "vitest";
import { looksLikeQQBotTarget, normalizeTarget, parseTarget } from "./target-parser.js";

describe("parseTarget", () => {
  it.each([
    { to: "qqbot:C2C:OpenIdCase", expected: { type: "c2c", id: "OpenIdCase" } },
    { to: "QQBOT:Group:GroupOpenId", expected: { type: "group", id: "GroupOpenId" } },
    { to: "CHANNEL:ChannelId", expected: { type: "channel", id: "ChannelId" } },
  ])("parses $to without changing identifier bytes", ({ to, expected }) => {
    expect(parseTarget(to)).toEqual(expected);
  });

  it("defaults bare IDs to c2c", () => {
    expect(parseTarget("bare-openid")).toEqual({ type: "c2c", id: "bare-openid" });
  });

  it("rejects type prefixes with empty IDs regardless of case", () => {
    expect(() => parseTarget("qqbot:c2c:")).toThrow(/missing user ID/);
    expect(() => parseTarget("qqbot:Group:")).toThrow(/missing group ID/);
    expect(() => parseTarget("CHANNEL:")).toThrow(/missing channel ID/);
    expect(() => parseTarget("qqbot:")).toThrow(/empty ID/);
  });
});

describe("normalizeTarget", () => {
  it.each([
    ["qqbot:Group:GroupOpenId", "qqbot:group:GroupOpenId"],
    ["C2C:OpenId", "qqbot:c2c:OpenId"],
    ["qqbot:channel:ChannelId", "qqbot:channel:ChannelId"],
  ])("normalizes %s to %s", (to, normalized) => {
    expect(looksLikeQQBotTarget(to)).toBe(true);
    expect(normalizeTarget(to)).toBe(normalized);
  });
});
