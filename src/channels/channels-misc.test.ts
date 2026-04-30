import { describe, expect, it } from "vitest";
import { normalizeChatType } from "./chat-type.js";

describe("normalizeChatType", () => {
  it.each([
    { name: "normalizes direct", value: "direct", expected: "direct" },
    { name: "normalizes dm alias", value: "dm", expected: "direct" },
    { name: "normalizes group", value: "group", expected: "group" },
    { name: "normalizes channel", value: "channel", expected: "channel" },
    { name: "returns undefined for undefined", value: undefined, expected: undefined },
    { name: "returns undefined for empty", value: "", expected: undefined },
    { name: "returns undefined for unknown value", value: "nope", expected: undefined },
    { name: "returns undefined for unsupported room", value: "room", expected: undefined },
  ] satisfies Array<{ name: string; value: string | undefined; expected: string | undefined }>)(
    "$name",
    ({ value, expected }) => {
      expect(normalizeChatType(value)).toBe(expected);
    },
  );

  describe("backward compatibility", () => {
    it("accepts legacy 'dm' value shape variants and normalizes to 'direct'", () => {
      // Legacy config/input may use "dm" with non-canonical casing/spacing.
      expect(normalizeChatType("DM")).toBe("direct");
      expect(normalizeChatType(" dm ")).toBe("direct");
    });
  });
});
