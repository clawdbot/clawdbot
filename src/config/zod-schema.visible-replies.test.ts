// Covers visible-reply config schema parsing and defaults.
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation-core.js";

describe("visible reply config schema", () => {
  describe.each(["global", "groupChat"] as const)("%s visibleReplies", (scope) => {
    it.each([
      [true, "automatic"],
      [false, "message_tool"],
    ] as const)("coerces %s to %s", (visibleReplies, expected) => {
      const messages = scope === "global" ? { visibleReplies } : { groupChat: { visibleReplies } };
      const result = validateConfigObjectRaw({ messages });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const parsed =
          scope === "global" ? result.config.messages : result.config.messages?.groupChat;
        expect(parsed?.visibleReplies).toBe(expected);
      }
    });
  });

  it.each(["user_request", "room_event"] as const)(
    "accepts enum unmentioned group inbound value %s",
    (unmentionedInbound) => {
      const result = validateConfigObjectRaw({ messages: { groupChat: { unmentionedInbound } } });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.messages?.groupChat?.unmentionedInbound).toBe(unmentionedInbound);
      }
    },
  );

  it.each([
    { messages: { visibleReplies: "visible" }, path: "messages.visibleReplies" },
    {
      messages: { groupChat: { unmentionedInbound: true } },
      path: "messages.groupChat.unmentionedInbound",
    },
  ])("rejects unsupported values at $path", ({ messages, path }) => {
    const result = validateConfigObjectRaw({ messages });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({ path }));
    }
  });
});
