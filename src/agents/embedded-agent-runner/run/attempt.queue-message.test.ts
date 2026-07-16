// Coverage for queued steering message commit and cancellation behavior.
import { describe, expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../../sessions/user-turn-transcript.test-support.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "./attempt.queue-message.js";

type EmbeddedAgentActiveSessionSteerTarget = Parameters<
  typeof steerActiveSessionWithOptionalDeliveryWait
>[0];

function steerWithDeliveryWait(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  deliveryTimeoutMs = 10_000,
): Promise<void> {
  return steerActiveSessionWithOptionalDeliveryWait(activeSession, text, {
    deliveryTimeoutMs,
    waitForTranscriptCommit: true,
  });
}

describe("embedded OpenClaw queued steering cancellation", () => {
  it("forwards prepared transcript context with a queued steering message", async () => {
    const steer = vi.fn(async () => undefined);
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "visible prompt", sender: { id: "user-42" } },
      target: createTestUserTurnTranscriptTarget(),
    });
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer,
      subscribe: () => () => {},
    };

    await steerActiveSessionWithOptionalDeliveryWait(activeSession, "runtime prompt", {
      userTurnTranscriptRecorder: recorder,
    });

    expect(steer).toHaveBeenCalledWith("runtime prompt", undefined, recorder);
  });

  it("forwards ordered images with a queued steering message", async () => {
    const steer = vi.fn(async () => undefined);
    const images = [
      { type: "image" as const, data: "first", mimeType: "image/jpeg" },
      { type: "image" as const, data: "second", mimeType: "image/png" },
    ];
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer,
      subscribe: () => () => {},
    };

    await steerActiveSessionWithOptionalDeliveryWait(activeSession, "compare these", { images });

    expect(steer).toHaveBeenCalledWith("compare these", images);
  });

  it("waits for the queued user message_end transcript boundary", async () => {
    // A queued steer is only durable once the user message_end event lands in
    // the active transcript.
    let emit!: (event: unknown) => void;
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      getSteeringMessages: () => [],
      steer: async () => {},
      subscribe: (listener) => {
        emit = listener;
        return () => {};
      },
    };
    const wait = steerWithDeliveryWait(activeSession, "queued completion");
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
    // Timeout cleanup must surgically remove the queued text entry without
    // damaging rich unrelated queued content.
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
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: {
        steeringQueue: {
          messages: queueMessages,
        },
      },
      getSteeringMessages: () => steeringUiMessages,
      steer: async () => {},
      subscribe: () => () => {},
    };

    vi.useFakeTimers();
    try {
      const wait = steerWithDeliveryWait(activeSession, "timed-out completion announce", 1);
      const rejection = expect(wait).rejects.toThrow(
        "queued steering message was not committed to the transcript before timeout",
      );
      await vi.advanceTimersByTimeAsync(1);
      await rejection;

      expect(queueMessages).toEqual([unrelatedMessage, trailingMessage]);
      expect(queueMessages[0]).toBe(unrelatedMessage);
      expect(queueMessages[0]?.content[1]).toBe(unrelatedImage);
      expect(queueMessages[1]).toBe(trailingMessage);
      expect(steeringUiMessages).toEqual(["keep this rich payload"]);
    } finally {
      vi.useRealTimers();
    }
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
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
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

    const wait = steerWithDeliveryWait(activeSession, "completion after parent stopped");
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

  it("keeps queued steering pending when auto-retry starts after agent_end", async () => {
    // agent_end can be followed by an automatic retry; do not cancel the queued
    // steer until the retry path either commits it or truly terminates.
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
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
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

      const wait = steerWithDeliveryWait(activeSession, "completion survives retry");

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

  it("keeps queued steering pending when auto-compaction starts after agent_end", async () => {
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
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
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

      const wait = steerWithDeliveryWait(activeSession, "completion survives compaction");

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
