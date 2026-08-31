import { describe, expect, it } from "vitest";
import { normalizeConversationReadInvocationOrigin } from "./conversation-read-origin.js";

describe("normalizeConversationReadInvocationOrigin", () => {
  it.each([
    [undefined, "delegated"],
    [null, "delegated"],
    ["delegated", "delegated"],
    ["DIRECT-OPERATOR", "delegated"],
    ["unknown", "delegated"],
    [{}, "delegated"],
    ["direct-operator", "direct-operator"],
  ] as const)("normalizes %j to %s", (value, expected) => {
    expect(normalizeConversationReadInvocationOrigin(value)).toBe(expected);
  });
});
