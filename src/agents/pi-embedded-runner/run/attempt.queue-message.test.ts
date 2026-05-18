import { describe, expect, it, vi } from "vitest";
import { __testing, type EmbeddedPiActiveSessionSteerTarget } from "./attempt.js";

describe("embedded Pi queued steering cancellation", () => {
  it("waits for the queued user message_end transcript boundary", async () => {
    let emit!: (event: unknown) => void;
    const activeSession: EmbeddedPiActiveSessionSteerTarget = {
      getSteeringMessages: () => [],
      steer: async () => {},
      subscribe: (listener) => {
        emit = listener;
        return () => {};
      },
    };
    const wait = __testing.steerAndWaitForTranscriptCommit(
      activeSession,
      "queued completion",
      10_000,
    );
    let settled = false;
    void wait.then(() => {
      settled = true;
    });

    emit({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "queued completion" }],
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "queued completion" }],
      },
    });

    await expect(wait).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("removes only the timed-out steering message and preserves unrelated payloads", async () => {
    const unrelatedImage = {
      type: "image",
      source: { type: "base64", data: "abc", media_type: "image/png" },
    };
    const unrelatedMessage = {
      role: "user",
      content: [{ type: "text", text: "keep this rich payload" }, unrelatedImage],
      timestamp: 1,
    };
    const targetMessage = {
      role: "user",
      content: [{ type: "text", text: "timed-out completion announce" }],
      timestamp: 2,
    };
    const trailingMessage = {
      role: "custom",
      customType: "notice",
      content: "preserve custom queued message",
      timestamp: 3,
    };
    const steeringUiMessages = ["keep this rich payload", "timed-out completion announce"];
    const queueMessages = [unrelatedMessage, targetMessage, trailingMessage];
    const activeSession: EmbeddedPiActiveSessionSteerTarget = {
      agent: {
        steeringQueue: {
          messages: queueMessages,
        },
      },
      getSteeringMessages: () => steeringUiMessages,
      steer: async () => {},
      subscribe: () => () => {},
    };

    await expect(
      __testing.cancelQueuedSteeringMessage(activeSession, "timed-out completion announce"),
    ).resolves.toBe(true);

    expect(queueMessages).toEqual([unrelatedMessage, trailingMessage]);
    expect(queueMessages[0]).toBe(unrelatedMessage);
    expect(queueMessages[0]?.content[1]).toBe(unrelatedImage);
    expect(queueMessages[1]).toBe(trailingMessage);
    expect(steeringUiMessages).toEqual(["keep this rich payload"]);
  });

  it("rejects and removes the queued steering message when the session ends first", async () => {
    vi.useFakeTimers();
    let emit!: (event: unknown) => void;
    const targetMessage = {
      role: "user",
      content: [{ type: "text", text: "completion after parent stopped" }],
      timestamp: 2,
    };
    const keepMessage = {
      role: "user",
      content: [{ type: "text", text: "keep unrelated queue entry" }],
      timestamp: 3,
    };
    const steeringUiMessages = ["completion after parent stopped", "keep unrelated queue entry"];
    const queueMessages = [targetMessage, keepMessage];
    let unsubscribed = false;
    const activeSession: EmbeddedPiActiveSessionSteerTarget = {
      agent: {
        steeringQueue: {
          messages: queueMessages,
        },
      },
      getSteeringMessages: () => steeringUiMessages,
      steer: async () => {},
      subscribe: (listener) => {
        emit = listener;
        return () => {
          unsubscribed = true;
        };
      },
    };

    const wait = __testing.steerAndWaitForTranscriptCommit(
      activeSession,
      "completion after parent stopped",
      10_000,
    );
    const rejection = expect(wait).rejects.toThrow(
      "active session ended before queued steering message was committed to the transcript",
    );

    emit({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(0);

    try {
      await rejection;
      expect(queueMessages).toEqual([keepMessage]);
      expect(steeringUiMessages).toEqual(["keep unrelated queue entry"]);
      expect(unsubscribed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps queued steering pending when Pi auto-retry starts after agent_end", async () => {
    vi.useFakeTimers();
    try {
      let emit!: (event: unknown) => void;
      const targetMessage = {
        role: "user",
        content: [{ type: "text", text: "completion survives retry" }],
        timestamp: 2,
      };
      const steeringUiMessages = ["completion survives retry"];
      const queueMessages = [targetMessage];
      const activeSession: EmbeddedPiActiveSessionSteerTarget = {
        agent: {
          steeringQueue: {
            messages: queueMessages,
          },
        },
        getSteeringMessages: () => steeringUiMessages,
        steer: async () => {},
        subscribe: (listener) => {
          emit = listener;
          return () => {};
        },
      };

      const wait = __testing.steerAndWaitForTranscriptCommit(
        activeSession,
        "completion survives retry",
        10_000,
      );

      emit({ type: "agent_end", messages: [] });
      emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1_000 });
      await vi.advanceTimersByTimeAsync(0);

      expect(queueMessages).toEqual([targetMessage]);
      expect(steeringUiMessages).toEqual(["completion survives retry"]);

      emit({
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "completion survives retry" }],
        },
      });

      await expect(wait).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps queued steering pending when Pi auto-compaction starts after agent_end", async () => {
    vi.useFakeTimers();
    try {
      let emit!: (event: unknown) => void;
      const targetMessage = {
        role: "user",
        content: [{ type: "text", text: "completion survives compaction" }],
        timestamp: 2,
      };
      const steeringUiMessages = ["completion survives compaction"];
      const queueMessages = [targetMessage];
      const activeSession: EmbeddedPiActiveSessionSteerTarget = {
        agent: {
          steeringQueue: {
            messages: queueMessages,
          },
        },
        getSteeringMessages: () => steeringUiMessages,
        steer: async () => {},
        subscribe: (listener) => {
          emit = listener;
          return () => {};
        },
      };

      const wait = __testing.steerAndWaitForTranscriptCommit(
        activeSession,
        "completion survives compaction",
        10_000,
      );

      emit({ type: "agent_end", messages: [] });
      emit({ type: "compaction_start", reason: "threshold" });
      await vi.advanceTimersByTimeAsync(0);

      expect(queueMessages).toEqual([targetMessage]);
      expect(steeringUiMessages).toEqual(["completion survives compaction"]);

      emit({
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "completion survives compaction" }],
        },
      });

      await expect(wait).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
