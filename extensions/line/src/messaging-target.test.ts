import { describe, expect, it } from "vitest";
import { inferLineTargetChatType, normalizeLineMessagingTarget } from "./messaging-target.js";

describe("LINE messaging targets", () => {
  const userId = `U${"a".repeat(32)}`;
  const groupId = `C${"b".repeat(32)}`;
  const roomId = `R${"c".repeat(32)}`;

  it("normalizes provider and kind prefixes", () => {
    expect(normalizeLineMessagingTarget(`line:user:${userId}`)).toBe(userId);
    expect(normalizeLineMessagingTarget(`line:group:${groupId}`)).toBe(groupId);
  });

  it("infers direct, group, and room target kinds", () => {
    expect(inferLineTargetChatType(userId)).toBe("direct");
    expect(inferLineTargetChatType(groupId)).toBe("group");
    expect(inferLineTargetChatType(`line:room:${roomId}`)).toBe("group");
    expect(inferLineTargetChatType("invalid")).toBeUndefined();
  });
});
