// Zalo tests cover durable webhook admission, replay, recovery, and failure taxonomy.
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloWebhookIngressRuntime } from "./webhook-spool.js";
import {
  createZaloWebhookTestEvent,
  waitForZaloWebhookVerdict,
  withZaloWebhookTestQueue,
  type ZaloWebhookTestPayload,
} from "./webhook-spool.test-support.js";

const { createZaloWebhookIngress } = zaloWebhookIngressRuntime;

function runtime() {
  return { error: vi.fn(), log: vi.fn() };
}

function rawEvent(params?: Parameters<typeof createZaloWebhookTestEvent>[0]): string {
  return JSON.stringify(createZaloWebhookTestEvent(params));
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Zalo durable webhook ingress", () => {
  it("serializes concurrent admissions across append backoff", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const realEnqueue = queue.enqueue.bind(queue);
      const admissionOrder: string[] = [];
      let failedFirstAttempt = false;
      const enqueue: typeof queue.enqueue = async (...args) => {
        admissionOrder.push(args[0]);
        if (!failedFirstAttempt) {
          failedFirstAttempt = true;
          throw new Error("sqlite busy");
        }
        return await realEnqueue(...args);
      };
      const serializedQueue: ChannelIngressQueue<ZaloWebhookTestPayload> = {
        ...queue,
        enqueue,
      };
      const ingress = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue: serializedQueue,
        deliver: vi.fn(),
      });

      await Promise.all([
        ingress.accept(rawEvent({ messageId: "admission-a", chatId: "same-chat" })),
        ingress.accept(rawEvent({ messageId: "admission-b", chatId: "same-chat" })),
      ]);

      expect(admissionOrder).toEqual(["admission-a", "admission-a", "admission-b"]);
      expect((await queue.listPending({ limit: "all" })).map((entry) => entry.id)).toEqual([
        "admission-a",
        "admission-b",
      ]);
      await ingress.stop();
    });
  });

  it("retries a failed append before acknowledging and fails closed after the bound", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const enqueue = vi.fn(async () => {
        throw new Error("sqlite unavailable");
      });
      const failingQueue: ChannelIngressQueue<ZaloWebhookTestPayload> = { ...queue, enqueue };
      const deliver = vi.fn(async () => {});
      const ingress = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue: failingQueue,
        deliver,
      });

      await expect(ingress.accept(rawEvent({ messageId: "append-failure" }))).rejects.toThrow(
        "sqlite unavailable",
      );
      expect(enqueue).toHaveBeenCalledTimes(3);
      expect(deliver).not.toHaveBeenCalled();
      await ingress.stop();
    });
  });

  it("recovers an uncompleted event with a fresh drain and dispatches exactly once", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const interrupted = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver: vi.fn(),
      });
      await interrupted.accept(rawEvent({ messageId: "restart" }));
      await interrupted.stop();

      const deliver = vi.fn(async (_update, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      recovered.start();
      try {
        await waitForZaloWebhookVerdict(queue, "restart", "completed");
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("keeps a completion tombstone and rejects a post-completion duplicate", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const deliver = vi.fn(async (_update, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      const raw = rawEvent({ messageId: "duplicate" });
      ingress.start();
      try {
        await ingress.accept(raw);
        await waitForZaloWebhookVerdict(queue, "duplicate", "completed");
        await ingress.accept(raw);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 600);
        });
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("preserves old replay-guard parity for the same message id with changed payload bytes", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const deliver = vi.fn(async (_update, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      ingress.start();
      try {
        await ingress.accept(rawEvent({ messageId: "redelivery", text: "original", date: 1 }));
        await waitForZaloWebhookVerdict(queue, "redelivery", "completed");
        await ingress.accept(
          rawEvent({ messageId: "redelivery", text: "transport redelivery", date: 2 }),
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 600);
        });
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver.mock.calls[0]?.[0].message?.text).toBe("original");
      } finally {
        await ingress.stop();
      }
    });
  });

  it("stores raw JSON and derives the conversation lane before dispatch normalization", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const event = createZaloWebhookTestEvent({
        messageId: "raw",
        chatId: "conversation-42",
        text: "before",
      });
      const deliveredText: string[] = [];
      const ingress = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver: async (update, lifecycle) => {
          deliveredText.push(update.message?.text ?? "");
          await lifecycle.onAdopted();
        },
      });
      const raw = JSON.stringify(event);
      await ingress.accept(raw);
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({
          id: "raw",
          laneKey: "chat:conversation-42",
          payload: { version: 1, rawEvent: raw },
        }),
      ]);
      event.message.text = "after";

      ingress.start();
      try {
        await waitForZaloWebhookVerdict(queue, "raw", "completed");
        expect(deliveredText).toEqual(["before"]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters malformed persisted JSON without dispatch", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      await queue.enqueue(
        "malformed",
        { version: 1, rawEvent: "{" },
        { laneKey: "chat:conversation-1" },
      );
      const deliver = vi.fn(async () => {});
      const ingress = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      ingress.start();
      try {
        await waitForZaloWebhookVerdict(queue, "malformed", "failed");
        expect(deliver).not.toHaveBeenCalled();
        const verdict = await queue.enqueue("malformed", { version: 1, rawEvent: "{}" });
        expect(verdict.kind).toBe("failed");
        if (verdict.kind === "failed") {
          expect(verdict.record.reason).toBe("invalid-event");
        }
      } finally {
        await ingress.stop();
      }
    });
  });

  it("retries transient dispatch failures", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const deliver = vi.fn(async (_update, lifecycle) => {
        if (deliver.mock.calls.length === 1) {
          throw new Error("temporary dispatch outage");
        }
        await lifecycle.onAdopted();
      });
      const ingress = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      ingress.start();
      try {
        await ingress.accept(rawEvent({ messageId: "retry" }));
        await waitForZaloWebhookVerdict(queue, "retry", "completed");
        expect(deliver).toHaveBeenCalledTimes(2);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters authentication failures without retry", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const deliver = vi.fn(async () => {
        throw Object.assign(new Error("invalid Zalo token"), { statusCode: 401 });
      });
      const ingress = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      ingress.start();
      try {
        await ingress.accept(rawEvent({ messageId: "auth-failure" }));
        await waitForZaloWebhookVerdict(queue, "auth-failure", "failed");
        expect(deliver).toHaveBeenCalledTimes(1);
        const verdict = await queue.enqueue("auth-failure", { version: 1, rawEvent: "{}" });
        expect(verdict.kind).toBe("failed");
        if (verdict.kind === "failed") {
          expect(verdict.record.reason).toBe("authentication-failed");
        }
      } finally {
        await ingress.stop();
      }
    });
  });

  it("waits for an active delivery before shutdown returns", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      let releaseDelivery = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const deliver = vi.fn(async (_update, lifecycle) => {
        await lifecycle.onAdopted();
        await deliveryGate;
      });
      const ingress = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      ingress.start();
      await ingress.accept(rawEvent({ messageId: "active-stop" }));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

      let stopped = false;
      const stopping = ingress.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(stopped).toBe(false);
      releaseDelivery();
      await stopping;
      expect(stopped).toBe(true);
    });
  });

  it("holds a deferred claim through shutdown until adoption settles", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      let deferredLifecycle:
        | Parameters<Parameters<typeof createZaloWebhookIngress>[0]["deliver"]>[1]
        | undefined;
      const deliver = vi.fn(async (_update, lifecycle) => {
        deferredLifecycle = lifecycle;
        lifecycle.onDeferred();
      });
      const ingress = createZaloWebhookIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      ingress.start();
      await ingress.accept(rawEvent({ messageId: "deferred-stop" }));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      expect(await queue.listClaims()).toHaveLength(1);

      let stopped = false;
      const stopping = ingress.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(stopped).toBe(false);
      if (!deferredLifecycle) {
        throw new Error("Zalo delivery did not expose its deferred lifecycle");
      }
      await deferredLifecycle.onAdopted();
      await stopping;
      expect(stopped).toBe(true);
      const verdict = await queue.enqueue("deferred-stop", { version: 1, rawEvent: "{}" });
      expect(verdict.kind).toBe("completed");
    });
  });
});
