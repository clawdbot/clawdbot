import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("visible reply config schema", () => {
  it("coerces boolean global visibleReplies values to the enum contract", () => {
    const automatic = validateConfigObjectRaw({
      messages: {
        visibleReplies: true,
      },
    });
    const toolOnly = validateConfigObjectRaw({
      messages: {
        visibleReplies: false,
      },
    });

    expect(automatic.ok).toBe(true);
    expect(toolOnly.ok).toBe(true);
    if (automatic.ok) {
      expect(automatic.config.messages?.visibleReplies).toBe("automatic");
    }
    if (toolOnly.ok) {
      expect(toolOnly.config.messages?.visibleReplies).toBe("message_tool");
    }
  });

  it("coerces boolean groupChat visibleReplies values to the enum contract", () => {
    const automatic = validateConfigObjectRaw({
      messages: {
        groupChat: {
          visibleReplies: true,
        },
      },
    });
    const toolOnly = validateConfigObjectRaw({
      messages: {
        groupChat: {
          visibleReplies: false,
        },
      },
    });

    expect(automatic.ok).toBe(true);
    expect(toolOnly.ok).toBe(true);
    if (automatic.ok) {
      expect(automatic.config.messages?.groupChat?.visibleReplies).toBe("automatic");
    }
    if (toolOnly.ok) {
      expect(toolOnly.config.messages?.groupChat?.visibleReplies).toBe("message_tool");
    }
  });

  it("keeps invalid visibleReplies values rejected", () => {
    const result = validateConfigObjectRaw({
      messages: {
        visibleReplies: "visible",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const visibleRepliesIssue = result.issues.find(
        (issue) => issue.path === "messages.visibleReplies",
      );
      expect(visibleRepliesIssue?.path).toBe("messages.visibleReplies");
    }
  });

  it("accepts enum ambient group turn values", () => {
    const legacy = validateConfigObjectRaw({
      messages: {
        groupChat: {
          ambientTurns: "user_request",
        },
      },
    });
    const roomEvent = validateConfigObjectRaw({
      messages: {
        groupChat: {
          ambientTurns: "room_event",
        },
      },
    });

    expect(legacy.ok).toBe(true);
    expect(roomEvent.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.config.messages?.groupChat?.ambientTurns).toBe("user_request");
    }
    if (roomEvent.ok) {
      expect(roomEvent.config.messages?.groupChat?.ambientTurns).toBe("room_event");
    }
  });

  it("rejects boolean ambient group turn values", () => {
    const result = validateConfigObjectRaw({
      messages: {
        groupChat: {
          ambientTurns: true,
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (candidate) => candidate.path === "messages.groupChat.ambientTurns",
      );
      expect(issue?.path).toBe("messages.groupChat.ambientTurns");
    }
  });
});
