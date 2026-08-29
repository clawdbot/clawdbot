// Line tests cover durable webhook admission, replay, and core-drain recovery.
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { webhook } from "@line/bot-sdk";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLineNodeWebhookHandler } from "./webhook-node.js";
import {
  createLineWebhookSpool,
  LineWebhookTerminalDeliveryError,
  type LineWebhookTurnAdoptionLifecycle,
} from "./webhook-spool.js";
import {
  callback,
  createEvent,
  payloadFor,
  runtime,
  type SpoolPayload,
  waitForVerdict,
  withQueue,
} from "./webhook-spool.test-support.js";

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
      const listPending = vi.spyOn(queue, "listPending");
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
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });

        const drainScansBeforeNinth = listPending.mock.calls.length;
        await spool.accept(callback(ninth));
        await vi.waitFor(() =>
          expect(listPending.mock.calls.length).toBeGreaterThan(drainScansBeforeNinth),
        );

        expect(deliver).toHaveBeenCalledTimes(8);
        expect(maxActiveDeliveries).toBe(8);
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id: "message:message-event-concurrency-8",
            laneKey: "user:user-8",
          }),
        ]);

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
          _events: readonly webhook.Event[],
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
          events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          if ((events[0] as webhook.MessageEvent).message.id === "message-event-stop-deferred") {
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
      const enqueue = vi.spyOn(queue, "enqueue");
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
        await expect(enqueue.mock.results.at(-1)?.value).resolves.toMatchObject({
          kind: "completed",
          duplicate: true,
        });

        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await spool.stop();
      }
    });
  });

  it("deduplicates a redelivered message id even when webhookEventId changes", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.spyOn(queue, "enqueue");
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
        await expect(enqueue.mock.results.at(-1)?.value).resolves.toMatchObject({
          kind: "completed",
          duplicate: true,
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
          for (const delivery of delivered) {
            if (delivery.type === "message" && delivery.message.type === "text") {
              deliveredText.push(delivery.message.text);
            }
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

  // LINE lanes are keyed per sender, so every part of one multi-image send shares
  // one. A part that defers while its set is incomplete must stop owning that lane
  // or the later parts can never arrive to complete it.
  // LINE splits one multi-image send across several webhook events on one lane.
  // The spool groups their claims so the set reaches the handler as a single turn.
  it("delivers a same-lane image set as one turn owning every part's claim", async () => {
    await withQueue(async (queue) => {
      const delivered: (readonly webhook.Event[])[] = [];
      const deliver = vi.fn(
        async (
          events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          delivered.push(events);
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });

      spool.start();
      try {
        for (const index of [2, 1, 3]) {
          await spool.accept(
            callback(
              createEvent({
                webhookEventId: `event-image-set-${index}`,
                userId: "user-image-set",
                imageSet: { id: "set-1", index, total: 3 },
              }),
            ),
          );
        }

        // One delivery carrying the whole set, ordered the way the sender picked.
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
        expect(delivered[0]?.map((event) => (event as webhook.MessageEvent).message.id)).toEqual([
          "message-event-image-set-1",
          "message-event-image-set-2",
          "message-event-image-set-3",
        ]);

        // Adopting that one turn settles all three durable claims.
        await vi.waitFor(async () => expect(await queue.listPending()).toHaveLength(0));
      } finally {
        await spool.stop();
      }
    });
  });

  // A part that arrives while the spool is stopping must not be parked in a buffer
  // that will never flush; it goes back so a restart redelivers the whole set.
  it("hands an image-set part back instead of buffering it while stopping", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async () => {});
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });

      spool.start();
      await spool.stop();
      await spool.accept(
        callback(
          createEvent({
            webhookEventId: "event-stopping-set",
            userId: "user-stopping",
            imageSet: { id: "set-stopping", index: 1, total: 3 },
          }),
        ),
      );

      // Still queued for a later process rather than consumed by a dead buffer.
      expect(await queue.listPending()).toHaveLength(1);
      expect(deliver).not.toHaveBeenCalled();
    });
  });

  // A text landing between image parts must not become the lane owner: the parts
  // that follow could then never be claimed, and the set would split into a
  // partial image turn, the text, and a second image turn.
  it("still aggregates a set when a text lands between its parts", async () => {
    await withQueue(async (queue) => {
      const turns: string[] = [];
      const deliver = vi.fn(
        async (
          events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          const kinds = events.map((event) => (event as webhook.MessageEvent).message.type);
          turns.push(`${kinds[0]}x${events.length}`);
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      const imagePart = (index: number) =>
        callback(
          createEvent({
            webhookEventId: `event-split-${index}`,
            userId: "user-split",
            imageSet: { id: "set-split", index, total: 3 },
          }),
        );

      spool.start();
      try {
        await spool.accept(imagePart(1));
        await spool.accept(
          callback(createEvent({ webhookEventId: "event-split-text", userId: "user-split" })),
        );
        await spool.accept(imagePart(2));
        await spool.accept(imagePart(3));

        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2), { timeout: 20_000 });
        // One image turn carrying all three parts, then the text behind it.
        expect(turns).toEqual(["imagex3", "textx1"]);
      } finally {
        await spool.stop();
      }
    });
  });

  // A combined delivery that rejects before the handoff rides back to the holder's
  // drain only. Every other part already returned as deferred, so the failure has
  // to reach their claims too or they stay held until recovery.
  it("returns every buffered claim when the combined delivery rejects", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async () => {
        throw new Error("combined turn failed before adoption");
      });
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });

      spool.start();
      try {
        for (const index of [1, 2]) {
          await spool.accept(
            callback(
              createEvent({
                webhookEventId: `event-reject-${index}`,
                userId: "user-reject",
                imageSet: { id: "set-reject", index, total: 2 },
              }),
            ),
          );
        }

        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
        // Both parts come back for retry; neither is stranded in a held claim.
        await vi.waitFor(
          async () => {
            const pending = await queue.listPending();
            expect(pending).toHaveLength(2);
          },
          { timeout: 20_000 },
        );
      } finally {
        await spool.stop();
      }
    });
  });

  // The lane is released so the rest of a set can be claimed; a message the sender
  // sent afterwards must still arrive after the images, not before them.
  it("keeps a later message on the same lane behind an incomplete image set", async () => {
    await withQueue(async (queue) => {
      const order: string[] = [];
      const deliver = vi.fn(
        async (
          events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          const kind = (events[0] as webhook.MessageEvent).message.type;
          if (kind === "image") {
            // The real handler fetches every part's media before its turn exists.
            // The lane has to stay held across that work, not just until the set
            // is taken, or the later message wins the race to the agent.
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 200);
            });
          }
          order.push(kind);
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });

      spool.start();
      try {
        // An image set that never completes: only its timer can release the lane.
        await spool.accept(
          callback(
            createEvent({
              webhookEventId: "event-incomplete",
              userId: "user-order",
              imageSet: { id: "set-order", index: 1, total: 3 },
            }),
          ),
        );
        await spool.accept(
          callback(createEvent({ webhookEventId: "event-after", userId: "user-order" })),
        );

        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2), { timeout: 20_000 });
        expect(order).toEqual(["image", "text"]);
      } finally {
        await spool.stop();
      }
    });
  });

  it("delivers two messages queued behind an image set in arrival order", async () => {
    await withQueue(async (queue) => {
      const order: string[] = [];
      let inFlight = 0;
      let overlapped = false;
      const deliver = vi.fn(
        async (
          events: readonly webhook.Event[],
          _destination: string,
          control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
        ) => {
          inFlight += 1;
          overlapped ||= inFlight > 1;
          const message = (events[0] as webhook.MessageEvent).message;
          const label = message.type === "text" ? message.text : message.type;
          // The first queued message prepares slowly. Released together, the
          // second would reach the agent first and reorder the conversation.
          const delayMs = label === "first" ? 200 : 0;
          if (delayMs > 0) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, delayMs);
            });
          }
          order.push(label);
          inFlight -= 1;
          await control.turnAdoptionLifecycle.onAdopted();
        },
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });

      spool.start();
      try {
        await spool.accept(
          callback(
            createEvent({
              webhookEventId: "event-set-queue",
              userId: "user-queue",
              imageSet: { id: "set-queue", index: 1, total: 3 },
            }),
          ),
        );
        await spool.accept(
          callback(
            createEvent({ webhookEventId: "event-first", userId: "user-queue", text: "first" }),
          ),
        );
        await spool.accept(
          callback(
            createEvent({ webhookEventId: "event-second", userId: "user-queue", text: "second" }),
          ),
        );

        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3), { timeout: 20_000 });
        expect(order).toEqual(["image", "first", "second"]);
        expect(overlapped).toBe(false);
      } finally {
        await spool.stop();
      }
    });
  });
});
