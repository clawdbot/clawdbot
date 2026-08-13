// Line tests cover durable webhook admission, replay, and core-drain recovery.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { webhook } from "@line/bot-sdk";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLineNodeWebhookHandler } from "./webhook-node.js";
import {
  createLineWebhookSpool,
  LineWebhookTerminalDeliveryError,
  type LineWebhookTurnAdoptionLifecycle,
} from "./webhook-spool.js";

type SpoolPayload = {
  version: number;
  rawEvent: string;
  destination: string;
};

const runtime = (): RuntimeEnv => ({ error: vi.fn(), exit: vi.fn(), log: vi.fn() });

function createEvent(params: {
  webhookEventId: string;
  messageId?: string;
  userId?: string;
  text?: string;
}): webhook.Event {
  return {
    type: "message",
    message: {
      id: params.messageId ?? `message-${params.webhookEventId}`,
      type: "text",
      text: params.text ?? "hello",
    },
    replyToken: "test-reply-token",
    timestamp: Date.now(),
    source: { type: "user", userId: params.userId ?? "user-1" },
    mode: "active",
    webhookEventId: params.webhookEventId,
    deliveryContext: { isRedelivery: false },
  } as webhook.MessageEvent;
}

function callback(event: webhook.Event): webhook.CallbackRequest {
  return { destination: "destination-1", events: [event] };
}

function payloadFor(event: webhook.Event): SpoolPayload {
  return { version: 1, rawEvent: JSON.stringify(event), destination: "destination-1" };
}

async function withQueue<T>(
  fn: (queue: ChannelIngressQueue<SpoolPayload>) => Promise<T>,
): Promise<T> {
  const createdDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-spool-"));
  const stateDir = await fs.realpath(createdDir);
  const queue = createChannelIngressQueue<SpoolPayload>({
    channelId: "line",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function waitForVerdict(
  queue: ChannelIngressQueue<SpoolPayload>,
  eventId: string,
  expected: "completed" | "failed",
): Promise<void> {
  await vi.waitFor(
    async () => {
      const verdict = await queue.enqueue(eventId, {
        version: 1,
        rawEvent: "{}",
        destination: "",
      });
      expect(verdict.kind).toBe(expected);
    },
    { timeout: 4_000 },
  );
}

function createResponse(): ServerResponse & { body?: string } {
  const response = {
    statusCode: 0,
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      response.headersSent = true;
      response.body = body;
    }),
    body: undefined as string | undefined,
  };
  return response as unknown as ServerResponse & { body?: string };
}

async function invokeSignedWebhook(params: {
  handler: ReturnType<typeof createLineNodeWebhookHandler>;
  body: string;
  channelSecret: string;
}): Promise<ServerResponse & { body?: string }> {
  const response = createResponse();
  await params.handler(
    {
      method: "POST",
      headers: {
        "x-line-signature": crypto
          .createHmac("SHA256", params.channelSecret)
          .update(params.body)
          .digest("base64"),
      },
    } as unknown as IncomingMessage,
    response,
  );
  return response;
}

describe("LINE webhook spool", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("does not acknowledge when durable enqueue fails", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.fn(async () => {
        throw new Error("sqlite unavailable");
      });
      const failingQueue: ChannelIngressQueue<SpoolPayload> = { ...queue, enqueue };
      const deliver = vi.fn(async () => {});
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue: failingQueue,
        deliver,
      });
      const body = JSON.stringify(callback(createEvent({ webhookEventId: "event-ack-fail" })));
      const channelSecret = "test-channel-secret";
      const handler = createLineNodeWebhookHandler({
        channelSecret,
        bot: { handleWebhook: spool.accept },
        runtime: runtime(),
        readBody: async () => body,
      });

      try {
        const response = await invokeSignedWebhook({ handler, body, channelSecret });

        expect(response.statusCode).toBe(500);
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await spool.stop();
      }
    });
  });

  it("caps active deliveries across repeated drain pumps", async () => {
    await withQueue(async (queue) => {
      let releaseDeliveries = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDeliveries = resolve;
      });
      let activeDeliveries = 0;
      let maxActiveDeliveries = 0;
      const deliver = vi.fn(async (_event, _destination, control) => {
        activeDeliveries += 1;
        maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
        await control.turnAdoptionLifecycle.onAdopted();
        try {
          await deliveryGate;
        } finally {
          activeDeliveries -= 1;
        }
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      const firstBatch = Array.from({ length: 8 }, (_, index) =>
        createEvent({
          webhookEventId: `event-concurrency-${index}`,
          userId: `user-${index}`,
        }),
      );
      const ninth = createEvent({ webhookEventId: "event-concurrency-8", userId: "user-8" });

      spool.start();
      try {
        await spool.accept({ destination: "destination-1", events: firstBatch });
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(8));

        await spool.accept(callback(ninth));
        // Hold the eight adopted-but-unfinished deliveries across two timer pumps.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_100);
        });

        expect(deliver).toHaveBeenCalledTimes(8);
        expect(maxActiveDeliveries).toBe(8);

        releaseDeliveries();
        await vi.waitFor(() => expect(activeDeliveries).toBe(0));
        await spool.accept(callback(ninth));
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(9));
        expect(maxActiveDeliveries).toBe(8);
      } finally {
        releaseDeliveries();
        await spool.stop();
      }
    });
  });

  it("waits for active delivery before releasing its claim on stop", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const firstDeliver = vi.fn(async () => {
        await deliveryGate;
      });
      const first = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver: firstDeliver,
      });
      const event = createEvent({ webhookEventId: "event-stop-active" });

      first.start();
      await first.accept(callback(event));
      await vi.waitFor(() => expect(firstDeliver).toHaveBeenCalledTimes(1));

      let stopSettled = false;
      const firstStop = first.stop();
      const secondStop = first.stop();
      expect(secondStop).toBe(firstStop);
      const stopping = firstStop.then(() => {
        stopSettled = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(stopSettled).toBe(false);
      expect(await queue.listClaims()).toHaveLength(1);

      releaseDelivery();
      await stopping;

      const restartedDeliver = vi.fn(async (_event, _destination, control) => {
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const restarted = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver: restartedDeliver,
      });
      restarted.start();
      try {
        await waitForVerdict(queue, "message:message-event-stop-active", "completed");
        expect(restartedDeliver).toHaveBeenCalledTimes(1);
      } finally {
        await restarted.stop();
      }
    });
  });

  it("disposes after the active-delivery stop grace expires", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      let lateLifecycle: LineWebhookTurnAdoptionLifecycle | undefined;
      const firstDeliver = vi.fn(
        async (
          _event: webhook.Event,
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          lateLifecycle = control.turnAdoptionLifecycle;
          await deliveryGate;
        },
      );
      const firstRuntime = runtime();
      const first = createLineWebhookSpool({
        accountId: "default",
        runtime: firstRuntime,
        queue,
        deliver: firstDeliver,
      });
      const event = createEvent({ webhookEventId: "event-stop-timeout" });

      first.start();
      await first.accept(callback(event));
      await vi.waitFor(() => expect(firstDeliver).toHaveBeenCalledTimes(1));

      vi.useFakeTimers();
      const stopping = first.stop();
      let stopSettled = false;
      void stopping.then(() => {
        stopSettled = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(4_999);
        expect(stopSettled).toBe(false);
        expect(lateLifecycle?.abortSignal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await stopping;
        expect(firstRuntime.log).toHaveBeenCalledWith(
          expect.stringContaining("timed out after 5000ms"),
        );
        if (!lateLifecycle) {
          throw new Error("LINE delivery did not expose its adoption lifecycle");
        }
        expect(lateLifecycle.abortSignal.aborted).toBe(true);
        lateLifecycle.onDeferred();
        await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
      } finally {
        vi.useRealTimers();
      }

      const restartedDeliver = vi.fn(async (_event, _destination, control) => {
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const restarted = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver: restartedDeliver,
      });
      restarted.start();
      try {
        await waitForVerdict(queue, "message:message-event-stop-timeout", "completed");
        expect(restartedDeliver).toHaveBeenCalledTimes(1);
      } finally {
        releaseDelivery();
        await restarted.stop();
      }
    });
  });

  it("waits for claims deferred after an active-delivery stop timeout", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      let deferredLifecycle: LineWebhookTurnAdoptionLifecycle | undefined;
      let activeLifecycle: LineWebhookTurnAdoptionLifecycle | undefined;
      const spoolRuntime = runtime();
      const deliver = vi.fn(
        async (
          event: webhook.Event,
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          if ((event as webhook.MessageEvent).message.id === "message-event-stop-deferred") {
            deferredLifecycle = control.turnAdoptionLifecycle;
            control.turnAdoptionLifecycle.onDeferred();
            return;
          }
          activeLifecycle = control.turnAdoptionLifecycle;
          await deliveryGate;
        },
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: spoolRuntime,
        queue,
        deliver,
      });

      spool.start();
      await spool.accept(callback(createEvent({ webhookEventId: "event-stop-active" })));
      await spool.accept(
        callback(createEvent({ webhookEventId: "event-stop-deferred", userId: "user-2" })),
      );
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));

      vi.useFakeTimers();
      const stopping = spool.stop();
      let stopSettled = false;
      void stopping.then(() => {
        stopSettled = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(spoolRuntime.log).toHaveBeenCalledWith(
          expect.stringContaining("timed out after 5000ms"),
        );
        expect(stopSettled).toBe(false);

        if (!deferredLifecycle || !activeLifecycle) {
          throw new Error("LINE deliveries did not expose their adoption lifecycles");
        }
        activeLifecycle.onDeferred();
        await deferredLifecycle.onAbandoned();
        await vi.advanceTimersByTimeAsync(0);
        expect(stopSettled).toBe(false);

        await activeLifecycle.onAbandoned();
        releaseDelivery();
        await stopping;
        expect(stopSettled).toBe(true);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        releaseDelivery();
        vi.useRealTimers();
      }
    });
  });

  it("waits for deferred claim settlement before disposing on stop", async () => {
    await withQueue(async (queue) => {
      let deferredLifecycle: LineWebhookTurnAdoptionLifecycle | undefined;
      const deliver = vi.fn(async (_event, _destination, control) => {
        deferredLifecycle = control.turnAdoptionLifecycle;
        control.turnAdoptionLifecycle.onDeferred();
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      const event = createEvent({ webhookEventId: "event-stop-deferred" });

      spool.start();
      await spool.accept(callback(event));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

      let stopSettled = false;
      const stopping = spool.stop().then(() => {
        stopSettled = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(stopSettled).toBe(false);
      expect(await queue.listClaims()).toHaveLength(1);

      if (!deferredLifecycle) {
        throw new Error("LINE delivery did not expose its deferred lifecycle");
      }
      await deferredLifecycle.onAbandoned();
      await stopping;
      expect(stopSettled).toBe(true);
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listPending()).toHaveLength(1);
    });
  });

  it("recovers an uncompleted event with a fresh drain and dispatches once", async () => {
    await withQueue(async (queue) => {
      const event = createEvent({ webhookEventId: "event-restart" });
      const first = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver: async () => {
          throw new Error("first drain must not dispatch");
        },
      });
      await first.accept(callback(event));
      await first.stop();

      const deliver = vi.fn(async (_event, _destination, control) => {
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const restarted = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      restarted.start();
      try {
        await waitForVerdict(queue, "message:message-event-restart", "completed");
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await restarted.stop();
      }
    });
  });

  it("keeps a completion tombstone and rejects a repeated delivery", async () => {
    await withQueue(async (queue) => {
      const event = createEvent({ webhookEventId: "event-duplicate" });
      const deliver = vi.fn(async (_event, _destination, control) => {
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await spool.accept(callback(event));
        await waitForVerdict(queue, "message:message-event-duplicate", "completed");

        await spool.accept(callback(event));
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 600);
        });

        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await spool.stop();
      }
    });
  });

  it("deduplicates a redelivered message id even when webhookEventId changes", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_event, _destination, control) => {
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await spool.accept(
          callback(createEvent({ webhookEventId: "delivery-a", messageId: "shared-message" })),
        );
        await waitForVerdict(queue, "message:shared-message", "completed");

        await spool.accept(
          callback(createEvent({ webhookEventId: "delivery-b", messageId: "shared-message" })),
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 600);
        });

        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await spool.stop();
      }
    });
  });

  it("stores raw event JSON and normalizes it only during dispatch", async () => {
    await withQueue(async (queue) => {
      const event = createEvent({ webhookEventId: "event-raw", text: "before" });
      const deliveredText: string[] = [];
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver: async (delivered, _destination, control) => {
          if (delivered.type === "message" && delivered.message.type === "text") {
            deliveredText.push(delivered.message.text);
          }
          await control.turnAdoptionLifecycle.onAdopted();
        },
      });
      await spool.accept(callback(event));
      const pending = await queue.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.laneKey).toBe("user:user-1");
      expect(pending[0]?.payload).toEqual({
        version: 1,
        rawEvent: JSON.stringify(event),
        destination: "destination-1",
      });
      (event as webhook.MessageEvent & { message: { type: "text"; text: string } }).message.text =
        "after";

      spool.start();
      try {
        await waitForVerdict(queue, "message:message-event-raw", "completed");
        expect(deliveredText).toEqual(["before"]);
      } finally {
        await spool.stop();
      }
    });
  });

  it("dead-letters malformed stored JSON without dispatch", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "message:malformed",
        { version: 1, rawEvent: "{", destination: "destination-1" },
        { laneKey: "user:user-1" },
      );
      const deliver = vi.fn(async () => {});
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await waitForVerdict(queue, "message:malformed", "failed");
        expect(deliver).not.toHaveBeenCalled();
        const verdict = await queue.enqueue("message:malformed", {
          version: 1,
          rawEvent: "{}",
          destination: "",
        });
        expect(verdict.kind).toBe("failed");
        if (verdict.kind === "failed") {
          expect(verdict.record.reason).toBe("invalid-event");
        }
      } finally {
        await spool.stop();
      }
    });
  });

  it("retries transient dispatch errors", async () => {
    await withQueue(async (queue) => {
      const event = createEvent({ webhookEventId: "event-retry" });
      const deliver = vi.fn(async (_event, _destination, control) => {
        if (deliver.mock.calls.length === 1) {
          throw new Error("temporary dispatch outage");
        }
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await spool.accept(callback(event));
        await waitForVerdict(queue, "message:message-event-retry", "completed");
        expect(deliver).toHaveBeenCalledTimes(2);
      } finally {
        await spool.stop();
      }
    });
  });

  it("dead-letters the eighth retryable failure without a minimum-age floor", async () => {
    await withQueue(async (queue) => {
      const event = createEvent({ webhookEventId: "event-retry-limit" });
      const eventId = "message:message-event-retry-limit";
      await queue.enqueue(eventId, payloadFor(event), { laneKey: "user:user-1" });
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const claim = await queue.claim(eventId);
        if (!claim) {
          throw new Error(`failed to seed LINE retry attempt ${attempt + 1}`);
        }
        await queue.release(claim, {
          lastError: "seeded transient failure",
          releasedAt: Date.now() - 4 * 60_000,
        });
      }
      const deliver = vi.fn(async () => {
        throw new Error("persistent transient failure");
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await waitForVerdict(queue, eventId, "failed");
        expect(deliver).toHaveBeenCalledTimes(1);
        const verdict = await queue.enqueue(eventId, payloadFor(event));
        expect(verdict.kind).toBe("failed");
        if (verdict.kind === "failed") {
          expect(verdict.record.reason).toBe("retry-limit-exceeded");
        }
      } finally {
        await spool.stop();
      }
    });
  });

  it("dead-letters LINE API authentication failures without retry", async () => {
    await withQueue(async (queue) => {
      const event = createEvent({ webhookEventId: "event-auth" });
      const deliver = vi.fn(async () => {
        throw Object.assign(new Error("invalid channel access token"), { status: 401 });
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await spool.accept(callback(event));
        const eventId = "message:message-event-auth";
        await waitForVerdict(queue, eventId, "failed");
        expect(deliver).toHaveBeenCalledTimes(1);
        const verdict = await queue.enqueue(eventId, payloadFor(event));
        expect(verdict.kind).toBe("failed");
        if (verdict.kind === "failed") {
          expect(verdict.record.reason).toBe("authentication-failed");
        }
      } finally {
        await spool.stop();
      }
    });
  });

  it("dead-letters delivery failures after side effects", async () => {
    await withQueue(async (queue) => {
      const event = createEvent({ webhookEventId: "event-terminal" });
      const deliver = vi.fn(async () => {
        throw new LineWebhookTerminalDeliveryError("reply token consumed");
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      try {
        await spool.accept(callback(event));
        const eventId = "message:message-event-terminal";
        await waitForVerdict(queue, eventId, "failed");
        expect(deliver).toHaveBeenCalledTimes(1);
        const verdict = await queue.enqueue(eventId, payloadFor(event));
        expect(verdict.kind).toBe("failed");
        if (verdict.kind === "failed") {
          expect(verdict.record.reason).toBe("delivery-side-effects-committed");
        }
      } finally {
        await spool.stop();
      }
    });
  });
});
