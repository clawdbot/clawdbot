// Coverage for queued steering message commit and cancellation behavior.
import { describe, expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../../sessions/user-turn-transcript.test-support.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "./attempt.queue-message.js";

type EmbeddedAgentActiveSessionSteerTarget = Parameters<
  typeof steerActiveSessionWithOptionalDeliveryWait
>[0];

function userMessage(text: string, timestamp = 1) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp,
  };
}

function steerWithDeliveryWait(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  deliveryTimeoutMs = 10_000,
): ReturnType<typeof steerActiveSessionWithOptionalDeliveryWait> {
  return steerActiveSessionWithOptionalDeliveryWait(activeSession, text, {
    deliveryTimeoutMs,
    waitForTranscriptCommit: true,
  });
}

describe("embedded OpenClaw queued steering cancellation", () => {
  it("forwards prepared transcript context with a queued steering message", async () => {
    const receipt = userMessage("runtime prompt");
    const steer = vi.fn(async () => receipt);
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "visible prompt", sender: { id: "user-42" } },
      target: createTestUserTurnTranscriptTarget(),
    });
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer,
      cancelSteer: () => false,
      subscribe: () => () => {},
    };

    await steerActiveSessionWithOptionalDeliveryWait(activeSession, "runtime prompt", {
      userTurnTranscriptRecorder: recorder,
    });

    expect(steer).toHaveBeenCalledWith("runtime prompt", undefined, recorder);
  });

  it("forwards ordered images with a queued steering message", async () => {
    const receipt = userMessage("compare these");
    const steer = vi.fn(async () => receipt);
    const images = [
      { type: "image" as const, data: "first", mimeType: "image/jpeg" },
      { type: "image" as const, data: "second", mimeType: "image/png" },
    ];
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer,
      cancelSteer: () => false,
      subscribe: () => () => {},
    };

    await steerActiveSessionWithOptionalDeliveryWait(activeSession, "compare these", { images });

    expect(steer).toHaveBeenCalledWith("compare these", images);
  });

  it("forwards ordered prompt facts with a queued steering message", async () => {
    const receipt = userMessage("inspect both");
    const steer = vi.fn(async () => receipt);
    const media = [
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "/tmp/b.pdf", contentType: "application/pdf" },
    ];
    const imageOrder = ["offloaded", "inline"] as const;
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer,
      cancelSteer: () => false,
      subscribe: () => () => {},
    };

    await steerActiveSessionWithOptionalDeliveryWait(activeSession, "inspect both", {
      media,
      imageOrder: [...imageOrder],
    });

    expect(steer).toHaveBeenCalledWith("inspect both", undefined, undefined, media, imageOrder);
  });

  it("waits for the queued user message_end transcript boundary", async () => {
    // A queued steer is only durable once the user message_end event lands in
    // the active transcript.
    let emit!: (event: unknown) => void;
    const receipt = userMessage("queued completion");
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: async () => receipt,
      cancelSteer: () => false,
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
      message: receipt,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit({
      type: "message_end",
      message: receipt,
    });

    await expect(wait).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("correlates concurrent identical text by exact queue receipt", async () => {
    const listeners = new Set<(event: unknown) => void>();
    const firstReceipt = userMessage("same delegated prompt", 1);
    const secondReceipt = userMessage("same delegated prompt", 2);
    const receipts = [firstReceipt, secondReceipt];
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: async () => receipts.shift()!,
      cancelSteer: () => false,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    const firstWait = steerWithDeliveryWait(activeSession, "same delegated prompt");
    const secondWait = steerWithDeliveryWait(activeSession, "same delegated prompt");
    let secondSettled = false;
    void secondWait.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    for (const listener of listeners) {
      listener({ type: "message_end", message: firstReceipt });
    }
    await expect(firstWait).resolves.toBeUndefined();
    expect(secondSettled).toBe(false);

    for (const listener of listeners) {
      listener({ type: "message_end", message: secondReceipt });
    }
    await expect(secondWait).resolves.toBeUndefined();
  });

  it("cancels only its exact receipt when identical text is queued twice", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(event: unknown) => void>();
      const firstReceipt = userMessage("same delegated prompt", 1);
      const secondReceipt = userMessage("same delegated prompt", 2);
      const receipts = [firstReceipt, secondReceipt];
      const queued: unknown[] = [firstReceipt, secondReceipt];
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
        steer: async () => receipts.shift()!,
        cancelSteer: (receipt) => {
          const index = queued.indexOf(receipt);
          if (index === -1) {
            return false;
          }
          queued.splice(index, 1);
          return true;
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };

      const firstWait = steerWithDeliveryWait(activeSession, "same delegated prompt", 10_000);
      const secondWait = steerWithDeliveryWait(activeSession, "same delegated prompt", 1);
      const secondRejection = expect(secondWait).rejects.toThrow(
        "queued steering message was not committed to the transcript before timeout",
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await secondRejection;

      expect(queued).toEqual([firstReceipt]);
      for (const listener of listeners) {
        listener({ type: "message_end", message: firstReceipt });
      }
      await expect(firstWait).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
    const targetMessage = userMessage("timed-out completion announce", 2);
    const trailingMessage = {
      role: "custom",
      customType: "notice",
      content: "preserve custom queued message",
      timestamp: 3,
    };
    const steeringUiMessages = ["keep this rich payload", "timed-out completion announce"];
    const queueMessages: unknown[] = [unrelatedMessage, targetMessage, trailingMessage];
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: async () => targetMessage,
      cancelSteer: (receipt) => {
        const index = queueMessages.indexOf(receipt);
        if (index === -1) {
          return false;
        }
        queueMessages.splice(index, 1);
        steeringUiMessages.splice(1, 1);
        return true;
      },
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
      expect(unrelatedMessage.content[1]).toBe(unrelatedImage);
      expect(queueMessages[1]).toBe(trailingMessage);
      expect(steeringUiMessages).toEqual(["keep this rich payload"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects and removes the queued steering message when the session ends first", async () => {
    vi.useFakeTimers();
    let emit!: (event: unknown) => void;
    const targetMessage = userMessage("completion after parent stopped", 2);
    const keepMessage = {
      role: "user",
      content: [{ type: "text", text: "keep unrelated queue entry" }],
      timestamp: 3,
    };
    const steeringUiMessages = ["completion after parent stopped", "keep unrelated queue entry"];
    const queueMessages: unknown[] = [targetMessage, keepMessage];
    let unsubscribed = false;
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: async () => targetMessage,
      cancelSteer: (receipt) => {
        const index = queueMessages.indexOf(receipt);
        if (index === -1) {
          return false;
        }
        queueMessages.splice(index, 1);
        steeringUiMessages.splice(index, 1);
        return true;
      },
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

  it("marks a missing queued message as accepted without transcript confirmation", async () => {
    vi.useFakeTimers();
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: async () => userMessage("possibly consumed"),
      cancelSteer: () => false,
      subscribe: () => () => {},
    };

    try {
      const wait = steerWithDeliveryWait(activeSession, "possibly consumed", 1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(wait).resolves.toEqual({
        transcriptCommit: "unconfirmed",
        errorMessage: "queued steering message was not committed to the transcript before timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an identical sibling when the exact receipt is already consumed", async () => {
    vi.useFakeTimers();
    try {
      const sibling = userMessage("same delegated prompt", 1);
      const consumed = userMessage("same delegated prompt", 2);
      const queued: unknown[] = [sibling];
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
        steer: async () => consumed,
        cancelSteer: (receipt) => {
          const index = queued.indexOf(receipt);
          if (index === -1) {
            return false;
          }
          queued.splice(index, 1);
          return true;
        },
        subscribe: () => () => {},
      };

      const wait = steerWithDeliveryWait(activeSession, "same delegated prompt", 1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);

      await expect(wait).resolves.toMatchObject({ transcriptCommit: "unconfirmed" });
      expect(queued).toEqual([sibling]);
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
      const targetMessage = userMessage("completion survives retry", 2);
      const steeringUiMessages = ["completion survives retry"];
      const queueMessages = [targetMessage];
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
        steer: async () => targetMessage,
        cancelSteer: () => false,
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
        message: targetMessage,
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
      const targetMessage = userMessage("completion survives compaction", 2);
      const steeringUiMessages = ["completion survives compaction"];
      const queueMessages = [targetMessage];
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
        steer: async () => targetMessage,
        cancelSteer: () => false,
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
        message: targetMessage,
      });

      await expect(wait).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
