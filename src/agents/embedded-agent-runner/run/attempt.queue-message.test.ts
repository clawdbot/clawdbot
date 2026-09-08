// Coverage for queued steering message commit and cancellation behavior.
import { describe, expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../../sessions/user-turn-transcript.test-support.js";
import type { AgentHarnessQuestionGatewayCall } from "../../harness/gateway-question-dispatch.js";
import { runAgentHarnessGatewayQuestion } from "../../harness/gateway-question.js";
import { registerQueuedUserMessageRetirement } from "../../sessions/queued-user-message-retirement.js";
import {
  reportSteeringMessagePersistenceFailure,
  setSteeringMessageIdentity,
} from "../../sessions/steering-message-identity.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "./attempt-queue-message.js";

type EmbeddedAgentActiveSessionSteerTarget = Parameters<
  typeof steerActiveSessionWithOptionalDeliveryWait
>[0];

function createIdentityAwareSteer(message: object): EmbeddedAgentActiveSessionSteerTarget["steer"] {
  return async (_text, _images, _recorder, _media, _imageOrder, queueIdentity) => {
    setSteeringMessageIdentity(
      message as Parameters<typeof setSteeringMessageIdentity>[0],
      queueIdentity,
    );
  };
}

function registerDisplayRetirement(message: object) {
  const retire = vi.fn(() => true);
  registerQueuedUserMessageRetirement(
    message as Parameters<typeof registerQueuedUserMessageRetirement>[0],
    retire,
  );
  return retire;
}

type SteeringMessage = Parameters<typeof setSteeringMessageIdentity>[0];
type CancelableAgent = NonNullable<EmbeddedAgentActiveSessionSteerTarget["agent"]>;

function queuedTextMessage(text: string, timestamp: number) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } satisfies SteeringMessage;
}

function createCancelableAgent(messages: object[]): CancelableAgent {
  return {
    cancelSteeringMessage: (predicate: (message: SteeringMessage) => boolean) => {
      const index = messages.findIndex((message) => predicate(message as SteeringMessage));
      return index < 0 ? undefined : (messages.splice(index, 1)[0] as SteeringMessage | undefined);
    },
  };
}

function steerWithDeliveryWait(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  deliveryTimeoutMs = 10_000,
  options: { queueIdentity?: string; abortSignal?: AbortSignal } = {},
): ReturnType<typeof steerActiveSessionWithOptionalDeliveryWait> {
  return steerActiveSessionWithOptionalDeliveryWait(activeSession, text, {
    deliveryTimeoutMs,
    waitForTranscriptCommit: true,
    ...options,
  });
}

describe("embedded OpenClaw queued steering cancellation", () => {
  it.each(["text", "offloaded", "recorded"] as const)(
    "keeps %s replies distinct from harness secrets",
    async (kind) => {
      const secretValue = "test-secret-value-123";
      const sessionKey = "agent:main:secret-transcript";
      const persistedTranscript: string[] = [];
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: secretValue,
          ...(kind === "recorded"
            ? { media: [{ path: "/tmp/image.png", contentType: "image/png" }] }
            : {}),
        },
        target: createTestUserTurnTranscriptTarget({ sessionKey }),
      });
      const persistApproved = vi.spyOn(recorder, "persistApproved").mockImplementation(async () => {
        persistedTranscript.push(JSON.stringify(recorder.message?.content));
        return undefined;
      });
      const onBlockReply = vi.fn(async () => undefined);
      const pendingSecret = runAgentHarnessGatewayQuestion({
        questions: [
          {
            id: "credential",
            header: "API key",
            question: "Enter the requested credential",
            isSecret: true,
            options: [],
          },
        ],
        sessionKey,
        timeoutMs: 60_000,
        gatewayCall: vi.fn<AgentHarnessQuestionGatewayCall>(),
        delivery: { onBlockReply },
      });
      const steer = vi.fn(async () => undefined);

      await steerActiveSessionWithOptionalDeliveryWait(
        { steer, subscribe: () => () => {} },
        secretValue,
        {
          isInboundUserMessage: true,
          userTurnTranscriptRecorder: recorder,
          ...(kind === "offloaded"
            ? { media: [{ path: "/tmp/image.png", contentType: "image/png" }] }
            : {}),
        },
        sessionKey,
      );

      await expect(pendingSecret).resolves.toEqual(
        kind === "text"
          ? {
              status: "answered",
              answers: { answers: { credential: [secretValue] } },
            }
          : { status: "cancelled" },
      );
      expect(persistApproved).not.toHaveBeenCalled();
      expect(recorder.hasPersisted()).toBe(false);
      expect(persistedTranscript.join("\n")).not.toContain(secretValue);
      expect(steer).toHaveBeenCalledTimes(kind === "text" ? 0 : 1);
    },
  );

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

    expect(steer).toHaveBeenCalledWith(
      "inspect both",
      undefined,
      undefined,
      media,
      imageOrder,
      undefined,
    );
  });

  it("waits for the queued user message_end transcript boundary", async () => {
    // A queued steer is only durable once the user message_end event lands in
    // the active transcript.
    let emit!: (event: unknown) => void;
    const queuedMessage = {
      role: "user",
      content: [{ type: "text", text: "queued completion" }],
    };
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: createIdentityAwareSteer(queuedMessage),
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

    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    emit({
      type: "message_start",
      message: queuedMessage,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit({
      type: "message_end",
      message: queuedMessage,
    });

    await expect(wait).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("rejects only the exact drained steer when its transcript append fails", async () => {
    const failedMessage = queuedTextMessage("same text", 1);
    const survivingMessage = { ...failedMessage, timestamp: 2 };
    setSteeringMessageIdentity(failedMessage, "failed-turn");
    setSteeringMessageIdentity(survivingMessage, "surviving-turn");
    const listeners = new Set<(event: unknown) => void>();
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: createCancelableAgent([]),
      steer: async () => {},
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const abortController = new AbortController();
    const failedWait = steerWithDeliveryWait(activeSession, "same text", 10_000, {
      queueIdentity: "failed-turn",
      abortSignal: abortController.signal,
    });
    const survivingWait = steerWithDeliveryWait(activeSession, "same text", 10_000, {
      queueIdentity: "surviving-turn",
      abortSignal: abortController.signal,
    });
    const rejection = expect(failedWait).rejects.toThrow("SQLite transcript append failed");

    try {
      await vi.waitFor(() => expect(listeners).toHaveLength(2));
      reportSteeringMessagePersistenceFailure(
        failedMessage,
        new Error("SQLite transcript append failed"),
      );
      await rejection;
      expect(listeners).toHaveLength(1);

      for (const listener of listeners) {
        listener({ type: "message_end", message: survivingMessage });
      }
      await expect(survivingWait).resolves.toBeUndefined();
      expect(listeners).toHaveLength(0);
    } finally {
      abortController.abort();
      await Promise.allSettled([failedWait, survivingWait, rejection]);
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
    const targetMessage = queuedTextMessage("timed-out completion announce", 2);
    const trailingMessage = {
      role: "custom",
      customType: "notice",
      content: "preserve custom queued message",
      timestamp: 3,
    };
    const queueMessages = [unrelatedMessage, targetMessage, trailingMessage];
    const retireDisplay = registerDisplayRetirement(targetMessage);
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: createCancelableAgent(queueMessages),
      steer: createIdentityAwareSteer(targetMessage),
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
      expect(retireDisplay).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an unconsumed terminal steer for normal-turn promotion", async () => {
    vi.useFakeTimers();
    let emit!: (event: unknown) => void;
    const targetMessage = queuedTextMessage("completion after parent stopped", 2);
    const keepMessage = queuedTextMessage("keep unrelated queue entry", 3);
    const queueMessages = [targetMessage, keepMessage];
    const retireDisplay = registerDisplayRetirement(targetMessage);
    let unsubscribed = false;
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: createCancelableAgent(queueMessages),
      steer: createIdentityAwareSteer(targetMessage),
      subscribe: (listener) => {
        emit = listener;
        return () => {
          unsubscribed = true;
        };
      },
    };

    const wait = steerWithDeliveryWait(activeSession, "completion after parent stopped");
    // Removing it from the dying in-memory runtime lets the reply queue promote
    // the same source turn instead of treating terminal completion as delivery.
    const rejection = expect(wait).rejects.toThrow(
      "active session ended before queued steering message was committed to the transcript",
    );

    try {
      await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
      emit({ type: "agent_settled" });
      await vi.advanceTimersByTimeAsync(0);

      await rejection;
      expect(queueMessages).toEqual([keepMessage]);
      expect(retireDisplay).toHaveBeenCalledOnce();
      expect(unsubscribed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a terminal steer before delayed preparation can enqueue it", async () => {
    vi.useFakeTimers();
    let emit!: (event: unknown) => void;
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let enqueued = false;
    const onQueueAccepted = vi.fn();
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: async (_text, _images, _recorder, _media, _imageOrder, _identity, canInject) => {
        await preparation;
        if (canInject && !canInject()) {
          throw new Error("active session is finalizing");
        }
        enqueued = true;
      },
      subscribe: (listener) => {
        emit = listener;
        return () => {};
      },
    };
    const wait = steerActiveSessionWithOptionalDeliveryWait(
      activeSession,
      "delayed steer",
      { deliveryTimeoutMs: 10_000, onQueueAccepted, waitForTranscriptCommit: true },
      undefined,
      () => true,
    );
    const rejection = expect(wait).rejects.toThrow(
      "active session ended before queued steering message was committed to the transcript",
    );

    try {
      await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
      emit({ type: "agent_settled" });
      await vi.advanceTimersByTimeAsync(0);
      releasePreparation();

      await rejection;
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueued).toBe(false);
      expect(onQueueAccepted).toHaveBeenCalledOnce();
      expect(onQueueAccepted).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a queued steer while its acceptance promise is still pending", async () => {
    let emit!: (event: unknown) => void;
    let releaseAcceptance!: () => void;
    const acceptance = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    let reportEnqueued!: () => void;
    const enqueued = new Promise<void>((resolve) => {
      reportEnqueued = resolve;
    });
    let reportSteerReturned!: () => void;
    const steerReturned = new Promise<void>((resolve) => {
      reportSteerReturned = resolve;
    });
    const targetMessage = queuedTextMessage("queued before settlement", 1);
    const queueMessages = [targetMessage];
    const retireDisplay = registerDisplayRetirement(targetMessage);
    const onQueueAccepted = vi.fn();
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: createCancelableAgent(queueMessages),
      steer: async (_text, _images, _recorder, _media, _imageOrder, queueIdentity) => {
        setSteeringMessageIdentity(targetMessage, queueIdentity);
        reportEnqueued();
        await acceptance;
        reportSteerReturned();
      },
      subscribe: (listener) => {
        emit = listener;
        return () => {};
      },
    };
    const wait = steerActiveSessionWithOptionalDeliveryWait(
      activeSession,
      "queued before settlement",
      { deliveryTimeoutMs: 10_000, onQueueAccepted, waitForTranscriptCommit: true },
    );
    const rejection = expect(wait).rejects.toThrow(
      "active session ended before queued steering message was committed to the transcript",
    );

    await enqueued;
    emit({ type: "agent_settled" });

    await rejection;
    expect(queueMessages).toEqual([]);
    expect(retireDisplay).toHaveBeenCalledOnce();
    expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(false);

    releaseAcceptance();
    await steerReturned;
    await Promise.resolve();
    expect(queueMessages).toEqual([]);
    expect(onQueueAccepted).toHaveBeenCalledOnce();
  });

  it("removes the runtime steer even when display retirement fails", async () => {
    let emit!: (event: unknown) => void;
    const targetMessage = queuedTextMessage("runtime ownership wins", 1);
    const queueMessages = [targetMessage];
    registerQueuedUserMessageRetirement(targetMessage, () => {
      throw new Error("display cleanup failed");
    });
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: createCancelableAgent(queueMessages),
      steer: createIdentityAwareSteer(targetMessage),
      subscribe: (listener) => {
        emit = listener;
        return () => {};
      },
    };
    const wait = steerWithDeliveryWait(activeSession, "runtime ownership wins");

    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    emit({ type: "agent_settled" });

    await expect(wait).rejects.toThrow(
      "active session ended before queued steering message was committed to the transcript",
    );
    expect(queueMessages).toEqual([]);
  });

  it("fences an aborted steer before delayed preparation can enqueue it", async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    let enqueued = false;
    const onQueueAccepted = vi.fn();
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: async (_text, _images, _recorder, _media, _imageOrder, _identity, canInject) => {
        preparationStarted();
        await preparation;
        if (canInject && !canInject()) {
          throw new Error("active session is finalizing");
        }
        enqueued = true;
      },
      subscribe: () => () => {},
    };
    const controller = new AbortController();
    const wait = steerActiveSessionWithOptionalDeliveryWait(activeSession, "delayed steer", {
      abortSignal: controller.signal,
      deliveryTimeoutMs: 10_000,
      onQueueAccepted,
      waitForTranscriptCommit: true,
    });
    const rejection = expect(wait).rejects.toThrow(
      "queued steering message was cancelled before acceptance",
    );

    await started;
    controller.abort();
    releasePreparation();

    await rejection;
    expect(enqueued).toBe(false);
    expect(onQueueAccepted).toHaveBeenCalledOnce();
    expect(onQueueAccepted).toHaveBeenCalledWith(false);
  });

  it("matches identical steering text by stable queue identity", async () => {
    let emit!: (event: unknown) => void;
    const first = queuedTextMessage("same text", 1);
    const second = { ...first, content: [...first.content], timestamp: 2 };
    setSteeringMessageIdentity(first, "steer-a");
    setSteeringMessageIdentity(second, "steer-b");
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: createCancelableAgent([first, second]),
      steer: async () => {},
      subscribe: (listener) => {
        emit = listener;
        return () => {};
      },
    };
    const wait = steerWithDeliveryWait(activeSession, "same text", 10_000, {
      queueIdentity: "steer-a",
    });
    let settled = false;
    void wait.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    emit({ type: "message_end", message: second });
    await Promise.resolve();
    expect(settled).toBe(false);
    emit({ type: "message_end", message: first });
    await expect(wait).resolves.toBeUndefined();
  });

  it("cancels the exact accepted steer when its source aborts", async () => {
    const first = queuedTextMessage("same text", 1);
    const second = { ...first, content: [...first.content], timestamp: 2 };
    setSteeringMessageIdentity(first, "steer-a");
    setSteeringMessageIdentity(second, "steer-b");
    const queueMessages = [first, second];
    const controller = new AbortController();
    const retireDisplay = registerDisplayRetirement(first);
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: createCancelableAgent(queueMessages),
      steer: async () => {},
      subscribe: () => () => {},
    };
    const wait = steerWithDeliveryWait(activeSession, "same text", 10_000, {
      queueIdentity: "steer-a",
      abortSignal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(wait).rejects.toThrow("queued steering message was cancelled before delivery");
    expect(queueMessages).toEqual([second]);
    expect(retireDisplay).toHaveBeenCalledOnce();
  });

  it("cancels the exact expanded steer without leaving a duplicate UI entry", async () => {
    const expandedText = "expanded steering text";
    const first = queuedTextMessage(expandedText, 1);
    const second = { ...first, content: [...first.content], timestamp: 2 };
    setSteeringMessageIdentity(first, "keep-first");
    setSteeringMessageIdentity(second, "cancel-second");
    const queueMessages = [first, second];
    const controller = new AbortController();
    const retireDisplay = registerDisplayRetirement(second);
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: createCancelableAgent(queueMessages),
      steer: async () => {},
      subscribe: () => () => {},
    };

    const wait = steerWithDeliveryWait(activeSession, "/expand same text", 10_000, {
      queueIdentity: "cancel-second",
      abortSignal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(wait).rejects.toThrow("queued steering message was cancelled before delivery");
    expect(queueMessages).toEqual([first]);
    expect(retireDisplay).toHaveBeenCalledOnce();
  });

  it("removes the empty UI entry for an image-only queued steer", async () => {
    const image = { type: "image" as const, data: "image-data", mimeType: "image/png" };
    const message = { role: "user" as const, content: [image], timestamp: 1 };
    setSteeringMessageIdentity(message, "image-only");
    const queueMessages = [message];
    const controller = new AbortController();
    const retireDisplay = registerDisplayRetirement(message);
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: createCancelableAgent(queueMessages),
      steer: async () => {},
      subscribe: () => () => {},
    };

    const wait = steerActiveSessionWithOptionalDeliveryWait(activeSession, "", {
      images: [image],
      queueIdentity: "image-only",
      abortSignal: controller.signal,
      deliveryTimeoutMs: 10_000,
      waitForTranscriptCommit: true,
    });
    await Promise.resolve();
    controller.abort();

    await expect(wait).rejects.toThrow("queued steering message was cancelled before delivery");
    expect(queueMessages).toEqual([]);
    expect(retireDisplay).toHaveBeenCalledOnce();
  });

  it("marks a missing queued message as accepted without transcript confirmation", async () => {
    vi.useFakeTimers();
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: createCancelableAgent([]),
      steer: async () => {},
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

  it("keeps queued steering pending when auto-retry starts after agent_end", async () => {
    // agent_end can be followed by an automatic retry; do not cancel the queued
    // steer until the retry path either commits it or truly terminates.
    vi.useFakeTimers();
    try {
      let emit!: (event: unknown) => void;
      const image = { type: "image" as const, data: "image-data", mimeType: "image/png" };
      const targetMessage = {
        role: "user",
        content: [{ type: "text", text: "" }, image],
        timestamp: 2,
      };
      const queueMessages = [targetMessage];
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
        agent: createCancelableAgent(queueMessages),
        steer: createIdentityAwareSteer(targetMessage),
        subscribe: (listener) => {
          emit = listener;
          return () => {};
        },
      };

      const wait = steerActiveSessionWithOptionalDeliveryWait(activeSession, "", {
        images: [image],
        deliveryTimeoutMs: 10_000,
        waitForTranscriptCommit: true,
      });

      await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
      emit({ type: "agent_end", messages: [] });
      await vi.advanceTimersByTimeAsync(0);
      emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1_000 });

      expect(queueMessages).toEqual([targetMessage]);

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
      const targetMessage = queuedTextMessage("completion survives compaction", 2);
      const queueMessages = [targetMessage];
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
        agent: createCancelableAgent(queueMessages),
        steer: createIdentityAwareSteer(targetMessage),
        subscribe: (listener) => {
          emit = listener;
          return () => {};
        },
      };

      const wait = steerWithDeliveryWait(activeSession, "completion survives compaction");

      await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
      emit({ type: "agent_end", messages: [] });
      emit({ type: "compaction_start", reason: "threshold" });
      await vi.advanceTimersByTimeAsync(0);

      expect(queueMessages).toEqual([targetMessage]);

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
