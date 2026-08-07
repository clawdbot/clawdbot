// Coverage for queued steering message commit and cancellation behavior.
import { describe, expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../../sessions/user-turn-transcript.test-support.js";
import { registerPendingAgentQuestion } from "../../harness/gateway-question.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "./attempt.queue-message.js";

type EmbeddedAgentActiveSessionSteerTarget = Parameters<
  typeof steerActiveSessionWithOptionalDeliveryWait
>[0];

type AgentSessionSteerReceipt = {
  committed: Promise<void>;
  cancel(): boolean;
};

type ReceiptAwareSteerTarget = EmbeddedAgentActiveSessionSteerTarget & {
  steerWithReceipt: (
    ...args: Parameters<EmbeddedAgentActiveSessionSteerTarget["steer"]>
  ) => Promise<AgentSessionSteerReceipt>;
};

function createDeferredReceipt(cancel: () => boolean = () => false): {
  receipt: AgentSessionSteerReceipt;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const committed = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void committed.catch(() => {});
  return {
    receipt: { committed, cancel },
    resolve,
    reject,
  };
}

function steerWithDeliveryWait(
  activeSession: ReceiptAwareSteerTarget,
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
    const steer = vi.fn(async () => undefined);
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "visible prompt", sender: { id: "user-42" } },
      target: createTestUserTurnTranscriptTarget(),
    });
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer,
      subscribe: () => () => {},
    };

    await expect(
      steerActiveSessionWithOptionalDeliveryWait(activeSession, "runtime prompt", {
        userTurnTranscriptRecorder: recorder,
      }),
    ).resolves.toEqual({
      kind: "steered",
      transcriptCommit: "not-requested",
    });

    expect(steer).toHaveBeenCalledWith("runtime prompt", undefined, recorder);
  });

  it("reports a claimed pending-input answer without steering", async () => {
    const sessionKey = "agent:main:queue-outcome";
    const answers = { answers: { answer: ["Continue"] } };
    const pending = registerPendingAgentQuestion({
      questionId: "ask_queue_outcome",
      sessionKey,
      questions: [
        {
          id: "answer",
          header: "Answer",
          question: "What should happen?",
          isOther: true,
          options: [],
        },
      ],
      gatewayCall: vi.fn(async () => ({ status: "answered", answers })),
      answer: Promise.resolve({ status: "answered", answers }),
    });
    const steer = vi.fn(async () => undefined);
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer,
      subscribe: () => () => {},
    };

    try {
      await expect(
        steerActiveSessionWithOptionalDeliveryWait(
          activeSession,
          "Continue",
          {
            isInboundUserMessage: true,
            waitForTranscriptCommit: true,
          },
          sessionKey,
        ),
      ).resolves.toEqual({ kind: "answered-pending-input" });
      expect(steer).not.toHaveBeenCalled();
    } finally {
      pending.dispose();
    }
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

  it("forwards ordered prompt facts with a queued steering message", async () => {
    const steer = vi.fn(async () => undefined);
    const media = [
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "/tmp/b.pdf", contentType: "application/pdf" },
    ];
    const imageOrder = ["offloaded", "inline"] as const;
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer,
      subscribe: () => () => {},
    };

    await steerActiveSessionWithOptionalDeliveryWait(activeSession, "inspect both", {
      media,
      imageOrder: [...imageOrder],
    });

    expect(steer).toHaveBeenCalledWith("inspect both", undefined, undefined, media, imageOrder);
  });

  it("waits for the session-owned transcript commit receipt", async () => {
    const deferred = createDeferredReceipt();
    const activeSession: ReceiptAwareSteerTarget = {
      steer: async () => undefined,
      steerWithReceipt: async () => deferred.receipt,
      subscribe: () => () => {},
    };
    const wait = steerWithDeliveryWait(activeSession, "queued completion");
    let settled = false;
    void wait.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    deferred.resolve();
    await expect(wait).resolves.toEqual({
      kind: "steered",
      transcriptCommit: "confirmed",
    });
    expect(settled).toBe(true);
  });

  it("rejects commit waits when the active session lacks receipt support", async () => {
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: async () => undefined,
      subscribe: () => () => {},
    };

    await expect(
      steerActiveSessionWithOptionalDeliveryWait(activeSession, "queued completion", {
        waitForTranscriptCommit: true,
      }),
    ).rejects.toThrow("active session does not support transcript commit receipts");
  });

  it("correlates concurrent identical text by exact queue receipt", async () => {
    const first = createDeferredReceipt();
    const second = createDeferredReceipt();
    const receipts = [first.receipt, second.receipt];
    const activeSession: ReceiptAwareSteerTarget = {
      steer: async () => undefined,
      steerWithReceipt: async () => receipts.shift()!,
      subscribe: () => () => {},
    };

    const firstWait = steerWithDeliveryWait(activeSession, "same delegated prompt");
    const secondWait = steerWithDeliveryWait(activeSession, "same delegated prompt");
    let secondSettled = false;
    void secondWait.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    first.resolve();
    await expect(firstWait).resolves.toEqual({
      kind: "steered",
      transcriptCommit: "confirmed",
    });
    expect(secondSettled).toBe(false);

    second.resolve();
    await expect(secondWait).resolves.toEqual({
      kind: "steered",
      transcriptCommit: "confirmed",
    });
  });

  it("cancels only its exact receipt when identical text is queued twice", async () => {
    vi.useFakeTimers();
    try {
      const queued = ["first", "second"];
      const first = createDeferredReceipt(() => {
        const index = queued.indexOf("first");
        if (index === -1) {
          return false;
        }
        queued.splice(index, 1);
        return true;
      });
      const second = createDeferredReceipt(() => {
        const index = queued.indexOf("second");
        if (index === -1) {
          return false;
        }
        queued.splice(index, 1);
        return true;
      });
      const receipts = [first.receipt, second.receipt];
      const activeSession: ReceiptAwareSteerTarget = {
        steer: async () => undefined,
        steerWithReceipt: async () => receipts.shift()!,
        subscribe: () => () => {},
      };

      const firstWait = steerWithDeliveryWait(activeSession, "same delegated prompt", 10_000);
      const secondWait = steerWithDeliveryWait(activeSession, "same delegated prompt", 1);
      const secondRejection = expect(secondWait).rejects.toThrow(
        "queued steering message was not committed to the transcript before timeout",
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await secondRejection;

      expect(queued).toEqual(["first"]);
      first.resolve();
      await expect(firstWait).resolves.toEqual({
        kind: "steered",
        transcriptCommit: "confirmed",
      });
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
    const targetMessage = { id: "target" };
    const trailingMessage = {
      role: "custom",
      customType: "notice",
      content: "preserve custom queued message",
      timestamp: 3,
    };
    const steeringUiMessages = ["keep this rich payload", "timed-out completion announce"];
    const queueMessages: unknown[] = [unrelatedMessage, targetMessage, trailingMessage];
    const deferred = createDeferredReceipt(() => {
      const index = queueMessages.indexOf(targetMessage);
      if (index === -1) {
        return false;
      }
      queueMessages.splice(index, 1);
      steeringUiMessages.splice(1, 1);
      return true;
    });
    const activeSession: ReceiptAwareSteerTarget = {
      steer: async () => undefined,
      steerWithReceipt: async () => deferred.receipt,
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
    const targetMessage = { id: "target" };
    const keepMessage = {
      role: "user",
      content: [{ type: "text", text: "keep unrelated queue entry" }],
      timestamp: 3,
    };
    const steeringUiMessages = ["completion after parent stopped", "keep unrelated queue entry"];
    const queueMessages: unknown[] = [targetMessage, keepMessage];
    let unsubscribed = false;
    const deferred = createDeferredReceipt(() => {
      const index = queueMessages.indexOf(targetMessage);
      if (index === -1) {
        return false;
      }
      queueMessages.splice(index, 1);
      steeringUiMessages.splice(index, 1);
      return true;
    });
    const activeSession: ReceiptAwareSteerTarget = {
      steer: async () => undefined,
      steerWithReceipt: async () => deferred.receipt,
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
    const deferred = createDeferredReceipt(() => false);
    const activeSession: ReceiptAwareSteerTarget = {
      steer: async () => undefined,
      steerWithReceipt: async () => deferred.receipt,
      subscribe: () => () => {},
    };

    try {
      const wait = steerWithDeliveryWait(activeSession, "possibly consumed", 1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(wait).resolves.toEqual({
        kind: "accepted-unconfirmed",
        errorMessage: "queued steering message was not committed to the transcript before timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an identical sibling when the exact receipt is already consumed", async () => {
    vi.useFakeTimers();
    try {
      const sibling = { id: "sibling" };
      const queued: unknown[] = [sibling];
      const consumed = createDeferredReceipt(() => false);
      const activeSession: ReceiptAwareSteerTarget = {
        steer: async () => undefined,
        steerWithReceipt: async () => consumed.receipt,
        subscribe: () => () => {},
      };

      const wait = steerWithDeliveryWait(activeSession, "same delegated prompt", 1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);

      await expect(wait).resolves.toMatchObject({ kind: "accepted-unconfirmed" });
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
      const deferred = createDeferredReceipt();
      const activeSession: ReceiptAwareSteerTarget = {
        steer: async () => undefined,
        steerWithReceipt: async () => deferred.receipt,
        subscribe: (listener) => {
          emit = listener;
          return () => {};
        },
      };

      const wait = steerWithDeliveryWait(activeSession, "completion survives retry");

      emit({ type: "agent_end", messages: [] });
      emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1_000 });
      await vi.advanceTimersByTimeAsync(0);

      deferred.resolve();
      await expect(wait).resolves.toEqual({
        kind: "steered",
        transcriptCommit: "confirmed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps queued steering pending when auto-compaction starts after agent_end", async () => {
    vi.useFakeTimers();
    try {
      let emit!: (event: unknown) => void;
      const deferred = createDeferredReceipt();
      const activeSession: ReceiptAwareSteerTarget = {
        steer: async () => undefined,
        steerWithReceipt: async () => deferred.receipt,
        subscribe: (listener) => {
          emit = listener;
          return () => {};
        },
      };

      const wait = steerWithDeliveryWait(activeSession, "completion survives compaction");

      emit({ type: "agent_end", messages: [] });
      emit({ type: "compaction_start", reason: "threshold" });
      await vi.advanceTimersByTimeAsync(0);

      deferred.resolve();
      await expect(wait).resolves.toEqual({
        kind: "steered",
        transcriptCommit: "confirmed",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
