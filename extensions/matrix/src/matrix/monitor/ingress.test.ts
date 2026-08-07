// Matrix tests cover durable inbound-event admission and restart replay.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import type { MatrixClient } from "../sdk.js";
import { registerMatrixMonitorEvents } from "./events.js";
import { createMatrixIngressMonitor, type MatrixIngressLifecycle } from "./ingress.js";
import type { MatrixRawEvent } from "./types.js";

type MatrixIngressPayload = {
  version: 1;
  receivedAt: number;
  roomId: string;
  rawEvent: MatrixRawEvent;
};

type MatrixIngressQueue = ChannelIngressQueue<MatrixIngressPayload>;

function createRawEvent(eventId: string, body = "hello"): MatrixRawEvent {
  return {
    event_id: eventId,
    type: "m.room.message",
    sender: "@alice:example.org",
    origin_server_ts: Date.now(),
    content: { msgtype: "m.text", body },
  } as unknown as MatrixRawEvent;
}

function runtime(): Pick<RuntimeEnv, "error" | "log"> {
  return { error: vi.fn(), log: vi.fn() };
}

function createMonitor(params: {
  queue: MatrixIngressQueue;
  dispatch: (
    roomId: string,
    event: MatrixRawEvent,
    lifecycle: MatrixIngressLifecycle,
  ) => Promise<void>;
  onUnjournaledEvent?: (roomId: string, event: MatrixRawEvent) => void;
  pollIntervalMs?: number;
}) {
  return createMatrixIngressMonitor({
    accountId: "default",
    runtime: runtime(),
    queue: params.queue,
    dispatch: params.dispatch,
    onUnjournaledEvent: params.onUnjournaledEvent ?? (() => {}),
    pollIntervalMs: params.pollIntervalMs ?? 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
}

async function withQueue<T>(fn: (queue: MatrixIngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-matrix-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<MatrixIngressPayload>({
    channelId: "matrix",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    // No closeOpenClawStateDatabaseForTest here: vitest shares one worker
    // across matrix test files and a global close races their open handles.
    // The per-test temp dir keeps each queue on its own SQLite file.
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Matrix durable ingress", () => {
  it("keeps waitForAdmissions pending behind a retrying append and a chained later event", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {});
      const monitor = createMonitor({ queue, dispatch });
      try {
        // The first append fails transiently; its 100 ms retry sleep runs
        // inside the admission tail while a later event waits behind it. The
        // sync-token persist gates on waitForAdmissions, so it must observe
        // this window instead of advancing the cursor past both events.
        const enqueueSpy = vi.spyOn(queue, "enqueue");
        enqueueSpy.mockImplementationOnce(() => Promise.reject(new Error("transient sqlite busy")));
        const first = monitor.accept("!room:example.org", createRawEvent("$evt-retry"));
        const second = monitor.accept("!room:example.org", createRawEvent("$evt-behind"));

        const waiting = monitor.waitForAdmissions();
        let settled = false;
        void waiting.then(() => {
          settled = true;
        });

        // The first attempt has failed by now and the tail is sleeping before
        // its retry: no append is in flight, yet the wait must stay pending.
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        expect(settled).toBe(false);
        expect(await queue.listPending({ limit: 10 })).toEqual([]);

        await first;
        await second;
        await waiting;
        expect(settled).toBe(true);
        expect(await queue.listPending({ limit: 10 })).toEqual([
          expect.objectContaining({ id: "$evt-retry" }),
          expect.objectContaining({ id: "$evt-behind" }),
        ]);
        expect(monitor.getAdmissionFailure()).toBe(null);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("records an admission failure after journal retries exhaust", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {});
      const monitor = createMonitor({ queue, dispatch });
      try {
        vi.spyOn(queue, "enqueue").mockRejectedValue(new Error("sqlite gone"));
        await monitor.accept("!room:example.org", createRawEvent("$evt-doomed"));
        expect(monitor.getAdmissionFailure()).toBeInstanceOf(Error);
        // The wait itself still settles: the gate pairs it with the failure
        // signal to freeze the cursor instead of blocking forever.
        await monitor.waitForAdmissions();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("retries a parked admission on the drain poll and clears the failure gate", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(
        async (_roomId: string, _event: MatrixRawEvent, _lifecycle: MatrixIngressLifecycle) => {},
      );
      const monitor = createMonitor({ queue, dispatch, pollIntervalMs: 10 });
      try {
        const enqueueSpy = vi
          .spyOn(queue, "enqueue")
          .mockRejectedValue(new Error("transient sqlite busy"));
        await monitor.accept("!room:example.org", createRawEvent("$evt-parked"));
        expect(monitor.getAdmissionFailure()).toBeInstanceOf(Error);
        expect(await queue.listPending({ limit: 10 })).toEqual([]);

        // The queue recovers without a restart: the next drain poll must
        // retry the parked admission, journal it, and lift the cursor gate.
        enqueueSpy.mockRestore();
        monitor.start();
        await vi.waitFor(() => {
          expect(monitor.getAdmissionFailure()).toBe(null);
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0]?.[1]?.event_id).toBe("$evt-parked");
      } finally {
        await monitor.stop();
      }
    });
  });

  it("queues a later same-room event behind a still-failing parked predecessor", async () => {
    await withQueue(async (queue) => {
      const dispatched: string[] = [];
      const dispatch = vi.fn(async (_roomId: string, event: MatrixRawEvent) => {
        dispatched.push(event.event_id ?? "");
      });
      const monitor = createMonitor({ queue, dispatch, pollIntervalMs: 10 });
      try {
        // Keep every journal append failing until the test flips the flag:
        // armed parked retries fire between accepts, so a fixed rejection
        // count would let a retry recover the queue mid-assertion.
        let queueHealthy = false;
        const originalEnqueue = queue.enqueue.bind(queue);
        const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation((...args) => {
          if (!queueHealthy) {
            return Promise.reject(new Error("sqlite busy"));
          }
          return originalEnqueue(...args);
        });
        await monitor.accept("!room:example.org", createRawEvent("$evt-older"));
        expect(monitor.getAdmissionFailure()).toBeInstanceOf(Error);

        // The newer event must not reach the journal while the predecessor
        // is still parked: every attempt so far belongs to the older event.
        await monitor.accept("!room:example.org", createRawEvent("$evt-newer"));
        expect(enqueueSpy.mock.calls.map((call) => call[0])).not.toContain("$evt-newer");
        expect(enqueueSpy.mock.calls.length).toBeGreaterThan(0);
        expect(await queue.listPending({ limit: 10 })).toEqual([]);
        expect(monitor.getAdmissionFailure()).toBeInstanceOf(Error);

        // Recovery keeps accept order: the poll retry lands both parked
        // events and the drain dispatches older before newer.
        queueHealthy = true;
        monitor.start();
        await vi.waitFor(() => {
          expect(dispatched).toEqual(["$evt-older", "$evt-newer"]);
        });
        expect(monitor.getAdmissionFailure()).toBe(null);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("commits the journal row before the sync token persist can fire", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {});
      const monitor = createMonitor({ queue, dispatch });
      try {
        // The sync listener calls accept without awaiting; the SQLite commit
        // must land in the same macrotask cycle, before the debounced (timer-
        // based) sync-token persist can mark the batch consumed.
        const accepted = monitor.accept("!room:example.org", createRawEvent("$evt-1"));
        expect(dispatch).not.toHaveBeenCalled();
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        await expect(queue.listPending({ limit: 10 })).resolves.toEqual([
          expect.objectContaining({ id: "$evt-1", laneKey: "room:!room:example.org" }),
        ]);
        await accepted;
      } finally {
        await monitor.stop();
      }
    });
  });

  it("replays a journaled event after a restart and dispatches exactly once", async () => {
    await withQueue(async (queue) => {
      // First process: journal the event but crash before the drain ran.
      const crashed = createMonitor({ queue, dispatch: vi.fn(async () => {}) });
      await crashed.accept("!room:example.org", createRawEvent("$evt-restart", "lost?"));
      // No stop(): simulates the gateway dying after the sync token persisted.

      const dispatch = vi.fn(
        async (_roomId: string, _event: MatrixRawEvent, lifecycle: MatrixIngressLifecycle) => {
          await lifecycle.onAdopted();
        },
      );
      const recovered = createMonitor({ queue, dispatch });
      try {
        recovered.start();
        await recovered.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0]?.[0]).toBe("!room:example.org");
        expect(dispatch.mock.calls[0]?.[1].event_id).toBe("$evt-restart");
        await expect(queue.listPending({ limit: 10 })).resolves.toHaveLength(0);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("delivers to an unrelated room while another room's turn is still running", async () => {
    await withQueue(async (queue) => {
      let releaseRoomA: (() => void) | undefined;
      const roomATurn = new Promise<void>((resolve) => {
        releaseRoomA = resolve;
      });
      const dispatched: string[] = [];
      const dispatch = vi.fn(
        async (roomId: string, event: MatrixRawEvent, lifecycle: MatrixIngressLifecycle) => {
          dispatched.push(event.event_id ?? "");
          if (roomId === "!room-a:example.org") {
            await roomATurn;
          }
          await lifecycle.onAdopted();
        },
      );
      const monitor = createMonitor({ queue, dispatch });
      try {
        monitor.start();
        await monitor.accept("!room-a:example.org", createRawEvent("$evt-a"));
        await vi.waitFor(() => expect(dispatched).toEqual(["$evt-a"]));

        // Room A's lane is occupied by a long turn; room B's event must still
        // dispatch — the pump waits on a per-idle wake, not on drain-wide idle.
        await monitor.accept("!room-b:example.org", createRawEvent("$evt-b"));
        await vi.waitFor(() => expect(dispatched).toEqual(["$evt-a", "$evt-b"]));

        releaseRoomA?.();
        await monitor.waitForIdle();
      } finally {
        releaseRoomA?.();
        await monitor.stop();
      }
    });
  });

  it("drains a same-room backlog event once the active turn settles", async () => {
    await withQueue(async (queue) => {
      let releaseFirst: (() => void) | undefined;
      const firstTurn = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const dispatched: string[] = [];
      const dispatch = vi.fn(
        async (_roomId: string, event: MatrixRawEvent, lifecycle: MatrixIngressLifecycle) => {
          dispatched.push(event.event_id ?? "");
          if (event.event_id === "$evt-first") {
            await firstTurn;
          }
          await lifecycle.onAdopted();
        },
      );
      const monitor = createMonitor({ queue, dispatch });
      try {
        monitor.start();
        await monitor.accept("!room:example.org", createRawEvent("$evt-first"));
        await vi.waitFor(() => expect(dispatched).toEqual(["$evt-first"]));

        // Same-lane backlog waits for the active claim (serialization), then
        // the idle wake re-pumps it without waiting for the 1 s poll tick.
        await monitor.accept("!room:example.org", createRawEvent("$evt-second"));
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        expect(dispatched).toEqual(["$evt-first"]);

        releaseFirst?.();
        await vi.waitFor(() => expect(dispatched).toEqual(["$evt-first", "$evt-second"]));
        await monitor.waitForIdle();
        await expect(queue.listPending({ limit: 10 })).resolves.toHaveLength(0);
      } finally {
        releaseFirst?.();
        await monitor.stop();
      }
    });
  });

  it("does not redispatch completed events across a restart", async () => {
    await withQueue(async (queue) => {
      const firstDispatch = vi.fn(
        async (_roomId: string, _event: MatrixRawEvent, lifecycle: MatrixIngressLifecycle) => {
          await lifecycle.onAdopted();
        },
      );
      const first = createMonitor({ queue, dispatch: firstDispatch });
      first.start();
      await first.accept("!room:example.org", createRawEvent("$evt-done"));
      await first.waitForIdle();
      expect(firstDispatch).toHaveBeenCalledTimes(1);
      await first.stop();

      const secondDispatch = vi.fn(async () => {});
      const second = createMonitor({ queue, dispatch: secondDispatch });
      try {
        second.start();
        await second.waitForIdle();
        expect(secondDispatch).not.toHaveBeenCalled();
      } finally {
        await second.stop();
      }
    });
  });

  it("keeps a failed dispatch claim for a later process instead of tombstoning", async () => {
    await withQueue(async (queue) => {
      const failingDispatch = vi.fn(async () => {
        throw new Error("handler exploded");
      });
      const failing = createMonitor({ queue, dispatch: failingDispatch });
      failing.start();
      await failing.accept("!room:example.org", createRawEvent("$evt-fail"));
      await vi.waitFor(() => expect(failingDispatch).toHaveBeenCalled());
      await failing.stop();

      const succeedingDispatch = vi.fn(
        async (_roomId: string, _event: MatrixRawEvent, lifecycle: MatrixIngressLifecycle) => {
          await lifecycle.onAdopted();
        },
      );
      const recovered = createMonitor({ queue, dispatch: succeedingDispatch, pollIntervalMs: 25 });
      try {
        recovered.start();
        await vi.waitFor(() => expect(succeedingDispatch).toHaveBeenCalledTimes(1), {
          timeout: 5_000,
          interval: 25,
        });
        await recovered.waitForIdle();
        await expect(queue.listPending({ limit: 10 })).resolves.toHaveLength(0);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("falls back to live dispatch for events without an event id", async () => {
    await withQueue(async (queue) => {
      const onUnjournaledEvent = vi.fn();
      const dispatch = vi.fn(async () => {});
      const monitor = createMonitor({ queue, dispatch, onUnjournaledEvent });
      try {
        monitor.start();
        const noId = { ...createRawEvent(""), event_id: "" } as MatrixRawEvent;
        await monitor.accept("!room:example.org", noId);
        expect(onUnjournaledEvent).toHaveBeenCalledTimes(1);
        await expect(queue.listPending({ limit: 10 })).resolves.toHaveLength(0);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("journals from the sync listener before the listener returns", async () => {
    await withQueue(async (queue) => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const client = {
        on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
          listeners.set(eventName, listener);
          return client;
        }),
      } as unknown as MatrixClient;
      const dispatch = vi.fn(
        async (_roomId: string, _event: MatrixRawEvent, lifecycle: MatrixIngressLifecycle) => {
          await lifecycle.onAdopted();
        },
      );
      const ingress = createMonitor({ queue, dispatch });
      try {
        registerMatrixMonitorEvents({
          cfg: { channels: { matrix: {} } } as CoreConfig,
          client,
          auth: { accountId: "default", encryption: false } as MatrixAuth,
          allowFrom: ["*"],
          dmEnabled: true,
          dmPolicy: "open",
          readStoreAllowFrom: async () => [],
          logVerboseMessage: () => {},
          warnedEncryptedRooms: new Set<string>(),
          warnedCryptoMissingRooms: new Set<string>(),
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          formatNativeDependencyHint: () => "hint",
          ingress,
        });
        const roomMessageListener = listeners.get("room.message");
        if (!roomMessageListener) {
          throw new Error("room.message listener was not registered");
        }
        // Emit synchronously like the SDK bridge does during doSync: the row
        // must be durable in the same macrotask cycle, before any debounced
        // (timer-based) sync-token persist can mark the batch consumed.
        roomMessageListener("!room:example.org", createRawEvent("$evt-sync", "from sync"));
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        await expect(queue.listPending({ limit: 10 })).resolves.toEqual([
          expect.objectContaining({ id: "$evt-sync" }),
        ]);
        expect(dispatch).not.toHaveBeenCalled();

        // Restart: a fresh drain replays the journaled event exactly once.
        ingress.start();
        await ingress.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await ingress.stop();
      }
    });
  });
});
