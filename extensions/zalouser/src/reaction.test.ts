import { describe, expect, it } from "vitest";
import { normalizeZaloReactionIcon } from "./reaction.js";

describe("zalouser reaction alias normalization", () => {
  it("maps common aliases", () => {
    expect(normalizeZaloReactionIcon("like")).toBe("/-strong");
    expect(normalizeZaloReactionIcon("👍")).toBe("/-strong");
    expect(normalizeZaloReactionIcon("heart")).toBe("/-heart");
    expect(normalizeZaloReactionIcon("😂")).toBe(":>");
  });

  it("defaults empty icon to like", () => {
    expect(normalizeZaloReactionIcon("")).toBe("/-strong");
  });

  it("passes through unknown custom reactions", () => {
    expect(normalizeZaloReactionIcon("/custom")).toBe("/custom");
  });
});
