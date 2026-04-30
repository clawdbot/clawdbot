import { describe, expect, it } from "vitest";
import {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
  normalizeDiscordOutboundTarget,
} from "./normalize.js";

describe("discord target normalization", () => {
  it("normalizes bare messaging target ids to channel targets", () => {
    expect(normalizeDiscordMessagingTarget("1234567890")).toBe("channel:1234567890");
  });

  it("keeps explicit outbound targets and rejects missing recipients", () => {
    expect(normalizeDiscordOutboundTarget("1234567890")).toEqual({
      ok: true,
      to: "channel:1234567890",
    });
    expect(normalizeDiscordOutboundTarget("user:42")).toEqual({
      ok: true,
      to: "user:42",
    });

    const result = normalizeDiscordOutboundTarget("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Discord recipient is required");
    }
  });

  it("treats bare outbound IDs listed in allowFrom as DM targets", () => {
    expect(normalizeDiscordOutboundTarget("1234567890", ["1234567890"])).toEqual({
      ok: true,
      to: "user:1234567890",
    });
    expect(normalizeDiscordOutboundTarget("2345678901", ["user:2345678901"])).toEqual({
      ok: true,
      to: "user:2345678901",
    });
    expect(normalizeDiscordOutboundTarget("3456789012", ["<@3456789012>"])).toEqual({
      ok: true,
      to: "user:3456789012",
    });
    expect(normalizeDiscordOutboundTarget("4567890123", ["*"])).toEqual({
      ok: true,
      to: "channel:4567890123",
    });
  });

  it("detects Discord-style target identifiers", () => {
    expect(looksLikeDiscordTargetId("<@!123456>")).toBe(true);
    expect(looksLikeDiscordTargetId("user:123456")).toBe(true);
    expect(looksLikeDiscordTargetId("discord:123456")).toBe(true);
    expect(looksLikeDiscordTargetId("123456")).toBe(true);
    expect(looksLikeDiscordTargetId("hello world")).toBe(false);
  });
});
