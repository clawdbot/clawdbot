// QQBot durable ingress tests cover raw admission, recovery, and twin parity.
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayEvent } from "./constants.js";
import { createQQBotIngressMonitor } from "./ingress.js";
import {
  qqC2CEnvelope,
  qqGroupEnvelope,
  type QQBotTestIngressPayload,
  withQQBotIngressQueue,
} from "./ingress.test-support.js";

type QQBotIngressDispatch = Parameters<typeof createQQBotIngressMonitor>[0]["dispatch"];

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function startMonitor(
  queue: ChannelIngressQueue<QQBotTestIngressPayload>,
  dispatch: QQBotIngressDispatch,
) {
  return createQQBotIngressMonitor({
    accountId: "default",
    queue,
    dispatch,
    pollIntervalMs: 10,
    adoptionStallTimeoutMs: 5_000,
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("QQBot durable ingress", () => {
  it("does not stage or dispatch before the raw envelope is durable", async () => {
    await withQQBotIngressQueue(async (queue) => {
      const appendGate = createDeferred();
      const enqueue = vi.fn(async (...args: Parameters<typeof queue.enqueue>) => {
        await appendGate.promise;
        return await queue.enqueue(...args);
      });
      const gatedQueue = { ...queue, enqueue };
      const dispatch = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(gatedQueue, dispatch);
      try {
        const admitted = monitor.receive(qqC2CEnvelope({ messageId: "durable-first" }));
        await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
        expect(dispatch).not.toHaveBeenCalled();

        appendGate.resolve();
        await admitted;
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      } finally {
        await monitor.stop();
      }
    });
  });

  it("recovers an uncompleted row with a fresh drain and dispatches exactly once", async () => {
    await withQQBotIngressQueue(async (queue) => {
      const firstDispatch = vi.fn(async () => ({ kind: "deferred" as const }));
      const first = startMonitor(queue, firstDispatch);
      await first.receive(qqC2CEnvelope({ messageId: "restart" }));
      await vi.waitFor(() => expect(firstDispatch).toHaveBeenCalledTimes(1));
      await first.stop();

      const recoveredDispatch = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = startMonitor(queue, recoveredDispatch);
      try {
        await vi.waitFor(() => expect(recoveredDispatch).toHaveBeenCalledTimes(1));
        await recovered.waitForIdle();
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("keeps a completion tombstone so a duplicate cannot dispatch twice", async () => {
    await withQQBotIngressQueue(async (queue) => {
      const dispatch = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        const envelope = qqC2CEnvelope({ messageId: "completed" });
        await monitor.receive(envelope);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
        await monitor.receive(envelope);
        await monitor.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("deduplicates group @ and full-message twins by stable message id", async () => {
    await withQQBotIngressQueue(async (queue) => {
      const dispatch = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await Promise.all([
          monitor.receive(
            qqGroupEnvelope({
              messageId: "logical-twin",
              deliveryId: "delivery-at",
              eventType: GatewayEvent.GROUP_AT_MESSAGE_CREATE,
            }),
          ),
          monitor.receive(
            qqGroupEnvelope({
              messageId: "logical-twin",
              deliveryId: "delivery-full",
              eventType: GatewayEvent.GROUP_MESSAGE_CREATE,
            }),
          ),
        ]);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      } finally {
        await monitor.stop();
      }
    });
  });

  it("preserves arrival order across an append retry backoff", async () => {
    await withQQBotIngressQueue(async (queue) => {
      let failFirst = true;
      const enqueue = queue.enqueue.bind(queue);
      queue.enqueue = async (...args) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("sqlite busy");
        }
        return await enqueue(...args);
      };
      const dispatched: string[] = [];
      const monitor = startMonitor(queue, async (message, lifecycle) => {
        dispatched.push(message.messageId);
        await lifecycle.onAdopted();
      });
      try {
        await Promise.all([
          monitor.receive(qqC2CEnvelope({ messageId: "first", sequence: 1 })),
          monitor.receive(qqC2CEnvelope({ messageId: "second", sequence: 2 })),
        ]);
        await vi.waitFor(() => expect(dispatched).toEqual(["first", "second"]));
      } finally {
        await monitor.stop();
      }
    });
  });

  it("does not dispatch from a pump racing stop through async prune", async () => {
    await withQQBotIngressQueue(async (queue) => {
      const pruneGate = createDeferred();
      const pruneStarted = createDeferred();
      const prune = queue.prune.bind(queue);
      queue.prune = async (...args) => {
        pruneStarted.resolve();
        await pruneGate.promise;
        return await prune(...args);
      };
      const dispatch = vi.fn();
      const monitor = startMonitor(queue, dispatch);
      await pruneStarted.promise;
      await monitor.receive(qqC2CEnvelope({ messageId: "stop-race" }));

      const stopping = monitor.stop();
      pruneGate.resolve();
      await stopping;
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("stores the exact raw envelope in the user conversation lane", async () => {
    await withQQBotIngressQueue(async (queue) => {
      const dispatch = vi.fn<QQBotIngressDispatch>(async () => ({ kind: "deferred" as const }));
      const monitor = startMonitor(queue, dispatch);
      const rawEnvelope = qqC2CEnvelope({ messageId: "raw", userId: "user-raw" });
      try {
        await monitor.receive(rawEnvelope);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
        expect(dispatch.mock.calls[0]?.[2]).toBe("message:raw");
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "message:raw",
            laneKey: "user:user-raw",
            payload: expect.objectContaining({ rawEnvelope }),
          }),
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("dead-letters malformed persisted envelopes without retry", async () => {
    await withQQBotIngressQueue(async (queue) => {
      await queue.enqueue(
        "message:malformed",
        { version: 1, receivedAt: 1, rawEnvelope: "{" },
        { receivedAt: 1, laneKey: "user:user-1" },
      );
      const dispatch = vi.fn();
      const monitor = startMonitor(queue, dispatch);
      try {
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("message:malformed", {
            version: 1,
            receivedAt: 1,
            rawEnvelope: "{}",
          });
          expect(verdict.kind).toBe("failed");
        });
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("dead-letters permanent QQ authentication failures", async () => {
    await withQQBotIngressQueue(async (queue) => {
      const dispatch = vi.fn(async () => {
        throw Object.assign(new Error("QQ API unauthorized"), { httpStatus: 401 });
      });
      const monitor = startMonitor(queue, dispatch);
      try {
        await monitor.receive(qqC2CEnvelope({ messageId: "auth" }));
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("message:auth", {
            version: 1,
            receivedAt: 1,
            rawEnvelope: "{}",
          });
          expect(verdict.kind).toBe("failed");
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });
});
