// @vitest-environment node
// Control UI tests cover history merge behavior.
import { describe, expect, it } from "vitest";
import { preserveOptimisticTailMessages } from "./history-merge.ts";

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

  it("keeps a new same-text user turn while history still ends at the earlier turn", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 10,
      __openclaw: {
        id: "first-user-message",
        idempotencyKey: "first-run:user",
        seq: 1,
      },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 20,
      __openclaw: { idempotencyKey: "second-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([persistedUser], [persistedUser, optimisticUser]),
    ).toEqual([persistedUser, optimisticUser]);
  });

  it("keeps a repeated user turn after the previous persisted assistant reply", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: {
        id: "first-user-message",
        idempotencyKey: "first-run:user",
        seq: 1,
      },
    };
    const persistedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      __openclaw: { id: "first-assistant-message", seq: 2 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 20,
      __openclaw: { idempotencyKey: "second-run:user" },
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, persistedAssistant],
        [persistedUser, persistedAssistant, optimisticUser],
      ),
    ).toEqual([persistedUser, persistedAssistant, optimisticUser]);
  });

  it("does not duplicate a repeated user turn after its own history entry arrives", () => {
    const persistedFirstUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: {
        id: "first-user-message",
        idempotencyKey: "first-run:user",
        seq: 1,
      },
    };
    const optimisticSecondUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 20,
      __openclaw: { idempotencyKey: "second-run:user" },
    };
    const persistedSecondUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 20,
      __openclaw: {
        id: "second-user-message",
        idempotencyKey: "second-run:user",
        seq: 2,
      },
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedFirstUser, persistedSecondUser],
        [persistedFirstUser, optimisticSecondUser],
      ),
    ).toEqual([persistedFirstUser, persistedSecondUser]);
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

  it("keeps an idempotency-marked queued turn while history is stale", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      __openclaw: { seq: 1 },
    };
    const materializedQueuedUser = {
      role: "user",
      content: [{ type: "text", text: "steered follow-up" }],
      timestamp: 10,
      __openclaw: { idempotencyKey: "steer-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([persistedUser], [persistedUser, materializedQueuedUser]),
    ).toEqual([persistedUser, materializedQueuedUser]);
  });
});
