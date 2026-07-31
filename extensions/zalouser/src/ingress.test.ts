// Zalouser tests cover durable socket admission, recovery, and replay semantics.
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createZalouserIngressMonitor, type ZalouserIngressLifecycle } from "./ingress.js";
import {
  createRawZalouserMessage,
  waitForZalouserIngressVerdict,
  withZalouserIngressTestQueue,
  type ZalouserTestIngressPayload,
} from "./ingress.test-support.js";

function runtime() {
  return { error: vi.fn(), log: vi.fn() };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Zalouser durable ingress", () => {
  it("finishes the durable append before dispatching", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      let releaseAppend = () => {};
      const appendGate = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      const realEnqueue = queue.enqueue.bind(queue);
      const enqueue: typeof queue.enqueue = async (...args) => {
        await appendGate;
        return await realEnqueue(...args);
      };
      const gatedQueue: ChannelIngressQueue<ZalouserTestIngressPayload> = {
        ...queue,
        enqueue,
      };
      const dispatch = vi.fn(async (_message, lifecycle: ZalouserIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue: gatedQueue,
        dispatch,
      });

      const admission = ingress.receive(createRawZalouserMessage({ msgId: "durable-first" }));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(dispatch).not.toHaveBeenCalled();

      releaseAppend();
      await admission;
      await waitForZalouserIngressVerdict(queue, "durable-first", "completed");
      expect(dispatch).toHaveBeenCalledOnce();
      await ingress.stop();
    });
  });

  it("recovers a pending event with a fresh drain and dispatches exactly once", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      const rawMessage = createRawZalouserMessage({ msgId: "restart" });
      await queue.enqueue(
        "restart",
        {
          version: 1,
          receivedAt: 1,
          rawMessage: JSON.stringify(rawMessage),
        },
        { receivedAt: 1, laneKey: "direct:sender-1" },
      );

      const dispatch = vi.fn(async (_message, lifecycle: ZalouserIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue,
        dispatch,
      });
      try {
        await waitForZalouserIngressVerdict(queue, "restart", "completed");
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        await recovered.stop();
      }
    });
  });

  it("rejects a post-completion duplicate by platform msgId", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      const dispatch = vi.fn(async (_message, lifecycle: ZalouserIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue,
        dispatch,
      });
      try {
        await ingress.receive(
          createRawZalouserMessage({ msgId: "duplicate", content: "original" }),
        );
        await waitForZalouserIngressVerdict(queue, "duplicate", "completed");
        await ingress.receive(
          createRawZalouserMessage({ msgId: "duplicate", content: "changed redelivery" }),
        );
        await ingress.waitForIdle();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls[0]?.[0].content).toBe("original");
      } finally {
        await ingress.stop();
      }
    });
  });

  it("stores the raw callback envelope and derives a conversation lane before normalization", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      const enqueues: Parameters<typeof queue.enqueue>[] = [];
      const realEnqueue = queue.enqueue.bind(queue);
      const observedQueue: ChannelIngressQueue<ZalouserTestIngressPayload> = {
        ...queue,
        enqueue: async (...args) => {
          enqueues.push(args);
          return await realEnqueue(...args);
        },
      };
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue: observedQueue,
        dispatch: async (_message, lifecycle) => {
          await lifecycle.onAdopted();
        },
      });
      const raw = createRawZalouserMessage({
        msgId: "raw",
        threadId: "group-42",
        content: "before",
        isGroup: true,
      });
      await ingress.receive(raw);
      raw.data.content = "after";

      expect(enqueues[0]?.[0]).toBe("raw");
      expect(enqueues[0]?.[1]).toMatchObject({
        version: 1,
        rawMessage: expect.stringContaining('"content":"before"'),
      });
      expect(enqueues[0]?.[2]).toMatchObject({ laneKey: "group:group-42" });
      await ingress.stop();
    });
  });

  it("serializes same-conversation claims until adoption", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      let firstLifecycle: ZalouserIngressLifecycle | undefined;
      const dispatch = vi.fn(async (_message, lifecycle: ZalouserIngressLifecycle) => {
        if (!firstLifecycle) {
          firstLifecycle = lifecycle;
          lifecycle.onDeferred();
          return;
        }
        await lifecycle.onAdopted();
      });
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue,
        dispatch,
        pollIntervalMs: 60_000,
      });
      await ingress.receive(createRawZalouserMessage({ msgId: "lane-1" }));
      await ingress.receive(createRawZalouserMessage({ msgId: "lane-2" }));
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

      await firstLifecycle?.onAdopted();
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
      await ingress.stop();
    });
  });

  it("dispatches another conversation while a deferred delivery is still active", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      let firstLifecycle: ZalouserIngressLifecycle | undefined;
      let releaseFirst = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const dispatch = vi.fn(
        async (message, lifecycle: ZalouserIngressLifecycle): Promise<void> => {
          if (message.msgId === "lane-active") {
            firstLifecycle = lifecycle;
            lifecycle.onDeferred();
            await firstGate;
            return;
          }
          await lifecycle.onAdopted();
        },
      );
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue,
        dispatch,
      });
      await ingress.receive(
        createRawZalouserMessage({ msgId: "lane-active", senderId: "sender-1" }),
      );
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

      await ingress.receive(
        createRawZalouserMessage({ msgId: "lane-independent", senderId: "sender-2" }),
      );
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
      await waitForZalouserIngressVerdict(queue, "lane-independent", "completed");

      releaseFirst();
      await firstLifecycle?.onAdopted();
      await ingress.stop();
    });
  });

  it("settles deferred bookkeeping when the adoption watchdog aborts a claim", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      let deferredLifecycle: ZalouserIngressLifecycle | undefined;
      const dispatch = vi.fn(async (_message, lifecycle: ZalouserIngressLifecycle) => {
        deferredLifecycle = lifecycle;
        lifecycle.onDeferred();
      });
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue,
        dispatch,
        adoptionStallTimeoutMs: 10,
      });
      await ingress.receive(createRawZalouserMessage({ msgId: "deferred-timeout" }));
      await waitForZalouserIngressVerdict(queue, "deferred-timeout", "failed");
      expect(deferredLifecycle?.abortSignal.aborted).toBe(true);

      await ingress.stop();
    });
  });

  it("aborts deferred bookkeeping during shutdown without waiting for adoption", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      let deferredLifecycle: ZalouserIngressLifecycle | undefined;
      const dispatch = vi.fn(async (_message, lifecycle: ZalouserIngressLifecycle) => {
        deferredLifecycle = lifecycle;
        lifecycle.onDeferred();
      });
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue,
        dispatch,
      });
      await ingress.receive(createRawZalouserMessage({ msgId: "deferred-stop" }));
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      expect(await queue.listClaims()).toHaveLength(1);

      await ingress.stop();
      expect(deferredLifecycle?.abortSignal.aborted).toBe(true);
      expect(await queue.listClaims()).toHaveLength(1);
    });
  });

  it("dead-letters malformed persisted envelopes without dispatch", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      await queue.enqueue(
        "malformed",
        { version: 1, receivedAt: 1, rawMessage: "{" },
        { receivedAt: 1, laneKey: "direct:sender-1" },
      );
      const dispatch = vi.fn();
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue,
        dispatch,
      });
      try {
        await waitForZalouserIngressVerdict(queue, "malformed", "failed");
        expect(dispatch).not.toHaveBeenCalled();
        const verdict = await queue.enqueue("malformed", {
          version: 1,
          receivedAt: 2,
          rawMessage: "{}",
        });
        expect(verdict.kind).toBe("failed");
        if (verdict.kind === "failed") {
          expect(verdict.record.reason).toBe("invalid-event");
        }
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters authentication failures without retry", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      const dispatch = vi.fn(async () => {
        throw Object.assign(new Error("expired session"), { code: 401 });
      });
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue,
        dispatch,
      });
      try {
        await ingress.receive(createRawZalouserMessage({ msgId: "auth-failure" }));
        await waitForZalouserIngressVerdict(queue, "auth-failure", "failed");
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("waits for in-flight admission and remains safe to stop twice", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      let releaseAppend = () => {};
      const appendGate = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      const realEnqueue = queue.enqueue.bind(queue);
      const gatedQueue: ChannelIngressQueue<ZalouserTestIngressPayload> = {
        ...queue,
        enqueue: async (...args) => {
          await appendGate;
          return await realEnqueue(...args);
        },
      };
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue: gatedQueue,
        dispatch: vi.fn(),
      });
      const admission = ingress.receive(createRawZalouserMessage({ msgId: "stop-admission" }));
      let stopped = false;
      const stopping = ingress.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(stopped).toBe(false);

      releaseAppend();
      await admission;
      await stopping;
      await expect(ingress.stop()).resolves.toBeUndefined();
    });
  });

  it("waits for an adopted active delivery before stop returns", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      let releaseDelivery = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const dispatch = vi.fn(async (_message, lifecycle: ZalouserIngressLifecycle) => {
        await lifecycle.onAdopted();
        await deliveryGate;
      });
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue,
        dispatch,
      });
      await ingress.receive(createRawZalouserMessage({ msgId: "active-stop" }));
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

      let stopped = false;
      const stopping = ingress.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(stopped).toBe(false);

      releaseDelivery();
      await stopping;
      expect(stopped).toBe(true);
    });
  });

  it("releases a pre-adoption delivery for retry during shutdown", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      let releaseDelivery = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const dispatch = vi.fn(async () => {
        await deliveryGate;
      });
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue,
        dispatch,
      });
      await ingress.receive(createRawZalouserMessage({ msgId: "shutdown-retry" }));
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

      const stopping = ingress.stop();
      releaseDelivery();
      await stopping;

      expect(await queue.listClaims()).toHaveLength(0);
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({ id: "shutdown-retry", lastError: expect.any(String) }),
      ]);
    });
  });

  it("does not start a claim after stop wins an async prune", async () => {
    await withZalouserIngressTestQueue(async (queue) => {
      await queue.enqueue(
        "shutdown",
        {
          version: 1,
          receivedAt: 1,
          rawMessage: JSON.stringify(createRawZalouserMessage({ msgId: "shutdown" })),
        },
        { receivedAt: 1, laneKey: "direct:sender-1" },
      );
      let releasePrune = () => {};
      const pruneGate = new Promise<void>((resolve) => {
        releasePrune = resolve;
      });
      const realPrune = queue.prune.bind(queue);
      const gatedQueue: ChannelIngressQueue<ZalouserTestIngressPayload> = {
        ...queue,
        prune: async (...args) => {
          await pruneGate;
          return await realPrune(...args);
        },
      };
      const dispatch = vi.fn();
      const ingress = createZalouserIngressMonitor({
        accountId: "default",
        ownUserId: "owner-1",
        runtime: runtime(),
        queue: gatedQueue,
        dispatch,
      });
      const stopping = ingress.stop();
      releasePrune();
      await stopping;

      expect(dispatch).not.toHaveBeenCalled();
      expect(await queue.listPending()).toHaveLength(1);
    });
  });
});
