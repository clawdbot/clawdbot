import { describe, expect, it } from "vitest";
import { preserveOptimisticTailMessages } from "../controllers/chat.ts";

describe("preserveOptimisticTailMessages", () => {
  it("keeps optimistic tail messages while history is stale", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      __openclaw: { seq: 1 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      timestamp: 10,
    };
    const optimisticAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "latest answer" }],
      timestamp: 11,
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedUser],
        [persistedUser, optimisticUser, optimisticAssistant],
      ),
    ).toEqual([persistedUser, optimisticUser, optimisticAssistant]);
  });

  it("drops streamed assistant tail when final history has caught up past the shared user", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
    const streamedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial streamed answer" }],
      timestamp: 10,
    };
    const historyAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "complete persisted answer" }],
      __openclaw: { seq: 2 },
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, historyAssistant],
        [persistedUser, streamedAssistant],
      ),
    ).toEqual([persistedUser, historyAssistant]);
  });
});
