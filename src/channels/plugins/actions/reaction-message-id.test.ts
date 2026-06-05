// Reaction message id tests cover channel action message id extraction and normalization.
import { describe, expect, it } from "vitest";
import { resolveReactionMessageId } from "./reaction-message-id.js";

describe("resolveReactionMessageId", () => {
  it("uses explicit messageId when present", () => {
    const result = resolveReactionMessageId({
      args: { messageId: "456" },
      toolContext: { currentMessageId: "123" },
    });
    expect(result).toBe("456");
  });

  it("accepts snake_case message_id alias", () => {
    const result = resolveReactionMessageId({ args: { message_id: "789" } });
    expect(result).toBe("789");
  });

  it("falls back to toolContext.currentMessageId", () => {
    const result = resolveReactionMessageId({
      args: {},
      toolContext: { currentMessageId: "9001" },
    });
    expect(result).toBe("9001");
  });
});
