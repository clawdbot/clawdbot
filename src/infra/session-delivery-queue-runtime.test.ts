// Covers same-process scheduling for durable session delivery retries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { drainPendingSessionDelivery } from "./session-delivery-queue-recovery.js";
import {
  schedulePendingSessionDeliveries,
  scheduleSessionDelivery,
  startSessionDeliveryRuntime,
} from "./session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery,
  enqueueSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  releaseSessionDeliveryClaim,
} from "./session-delivery-queue-storage.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function withRuntime(
  run: (start: typeof startSessionDeliveryRuntime) => Promise<void>,
): Promise<void> {
  await withTestDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      let stop: (() => void) | undefined;
      try {
        await run((params) => (stop = startSessionDeliveryRuntime(params)));
      } finally {
        // Retire the current owner before restoring its environment or removing its queue.
        stop?.();
      }
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe("session delivery queue runtime", () => {
  it("drains a newly scheduled durable entry", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime) => {
      const id = await enqueueSessionDelivery({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-1:agent-loop",
      });
      const deliver = vi.fn(async () => {});
      const onSettled = vi.fn(async () => {});
      const stop = startRuntime({ deliver, log: logger, onSettled });

      await expect(scheduleSessionDelivery(id)).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "recovered");
      expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
      stop();
    });
  });

  it("drains one scheduled id without parsing unrelated pending entries", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime) => {
      const id = await enqueueSessionDelivery({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "target delivery",
        messageId: "target:agent-loop",
      });
      for (let index = 0; index < 8; index += 1) {
        await enqueueSessionDelivery({
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: `unrelated delivery ${index}`,
          messageId: `unrelated:${index}:agent-loop`,
        });
      }
      const deliver = vi.fn(async () => {});
      startRuntime({ deliver, log: logger });
      const parseSpy = vi.spyOn(JSON, "parse");

      try {
        await expect(scheduleSessionDelivery(id)).resolves.toBe(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(parseSpy.mock.calls.length).toBeLessThanOrEqual(8);
      } finally {
        parseSpy.mockRestore();
      }
    });
  });

  it("retries a transient initial queue lookup failure", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime) => {
      const id = await enqueueSessionDelivery({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-initial-load:agent-loop",
      });
      const deliver = vi.fn(async () => {});
      const reloadPending = vi
        .fn<typeof loadPendingSessionDelivery>()
        .mockRejectedValueOnce(new Error("database busy"))
        .mockImplementation((entryId) => loadPendingSessionDelivery(entryId));
      startRuntime({ deliver, log: logger, reloadPending });

      await expect(scheduleSessionDelivery(id)).resolves.toBe(true);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to load"));
      expect(deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
    });
  });

  it("holds a claimed entry until release then rearms it immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    await withRuntime(async (startRuntime) => {
      const { id } = await enqueueClaimedSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-lease:agent-loop",
          idempotencyKey: "image:task-lease:agent-loop",
        },
        60_000,
      );
      const deliver = vi.fn(async () => {});
      startRuntime({ deliver, log: logger });

      await scheduleSessionDelivery(id);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(deliver).not.toHaveBeenCalled();

      await releaseSessionDeliveryClaim(id);
      await scheduleSessionDelivery(id);
      await vi.advanceTimersByTimeAsync(0);

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
    });
  });

  it("recomputes a future claim timer after the wall clock jumps forward", async () => {
    vi.useFakeTimers();
    const initialTime = new Date("2026-07-15T00:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1_000;
    vi.setSystemTime(initialTime);
    await withRuntime(async (startRuntime) => {
      const { id } = await enqueueClaimedSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-future-clock-jump:agent-loop",
          idempotencyKey: "image:task-future-clock-jump:agent-loop",
        },
        2 * dayMs,
      );
      const deliver = vi.fn(async () => {});
      startRuntime({ deliver, log: logger });

      await scheduleSessionDelivery(id);
      vi.setSystemTime(new Date(initialTime.getTime() + dayMs));
      await scheduleSessionDelivery(id);

      await vi.advanceTimersByTimeAsync(dayMs - 1);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
    });
  });

  it("preempts a released claim after the wall clock jumps past its lease", async () => {
    const initialTime = Date.now();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(initialTime);
    try {
      await withRuntime(async (startRuntime) => {
        const { id } = await enqueueClaimedSessionDelivery(
          {
            kind: "agentTurn",
            sessionKey: "agent:main:main",
            message: "generated image ready",
            messageId: "image:task-expired-clock-jump:agent-loop",
            idempotencyKey: "image:task-expired-clock-jump:agent-loop",
          },
          60_000,
        );
        const deliver = vi.fn(async () => {});
        startRuntime({ deliver, log: logger });

        await scheduleSessionDelivery(id);
        wallClock.mockReturnValue(initialTime + 24 * 60 * 60 * 1_000);
        await releaseSessionDeliveryClaim(id);
        await scheduleSessionDelivery(id);

        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
        expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
      });
    } finally {
      wallClock.mockRestore();
    }
  });

  it("coalesces duplicate schedules while the same entry is draining", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime) => {
      const id = await enqueueSessionDelivery({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-in-flight:agent-loop",
      });
      const delivery = createDeferredCore();
      const deliver = vi.fn(() => delivery.promise);
      let pendingDrain: ReturnType<typeof drainPendingSessionDelivery> | undefined;
      const stop = startRuntime({
        deliver,
        log: logger,
        drain: (params) => (pendingDrain = drainPendingSessionDelivery(params)),
      });

      try {
        await scheduleSessionDelivery(id);
        vi.advanceTimersByTime(0);
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

        await scheduleSessionDelivery(id);
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(1);

        delivery.resolve();
        await vi.waitFor(async () => {
          expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
        });
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        // Stop scheduling, then join the drain before the fixture removes its queue.
        stop();
        delivery.resolve();
        await pendingDrain;
      }
    });
  });

  it("retries a failed agent turn after durable backoff", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime) => {
      const id = await enqueueSessionDelivery({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated video ready",
        messageId: "video:task-1:agent-loop",
      });
      const deliver = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("session locked"))
        .mockResolvedValueOnce();
      startRuntime({ deliver, log: logger });

      await scheduleSessionDelivery(id);
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries()).toEqual([
        expect.objectContaining({ id, retryCount: 1, lastError: "session locked" }),
      ]);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(deliver).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
    });
  });

  it("rearms a pending entry after a transient final-state lookup failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    await withRuntime(async (startRuntime) => {
      const id = await enqueueSessionDelivery({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated video ready",
        messageId: "video:task-reload:agent-loop",
      });
      const deliver = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("session locked"))
        .mockResolvedValueOnce();
      const drain = vi
        .fn<typeof drainPendingSessionDelivery>()
        .mockImplementationOnce(async (params) => {
          await drainPendingSessionDelivery(params);
          throw new Error("database busy");
        })
        .mockImplementation((params) => drainPendingSessionDelivery(params));
      startRuntime({ deliver, drain, log: logger });

      await scheduleSessionDelivery(id);
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("runtime drain failed"));

      await vi.advanceTimersByTimeAsync(4_999);
      expect(deliver).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
    });
  });

  it("backs off after a drain-level failure leaves retry metadata unchanged", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime) => {
      const id = await enqueueSessionDelivery({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated video ready",
        messageId: "video:task-drain:agent-loop",
      });
      const deliver = vi.fn(async () => {});
      const drain = vi
        .fn<typeof drainPendingSessionDelivery>()
        .mockRejectedValueOnce(new Error("database scan failed"))
        .mockImplementation((params) => drainPendingSessionDelivery(params));
      startRuntime({ deliver, drain, log: logger });

      await scheduleSessionDelivery(id);
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("runtime drain failed"));
      expect(deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
    });
  });

  it("backs off after a no-op drain leaves an immediately due row pending", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime) => {
      const id = await enqueueSessionDelivery({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated video ready",
        messageId: "video:task-owned-elsewhere:agent-loop",
      });
      const deliver = vi.fn(async () => {});
      const drain = vi
        .fn<typeof drainPendingSessionDelivery>()
        .mockImplementationOnce((params) => loadPendingSessionDelivery(params.id, params.stateDir))
        .mockImplementation((params) => drainPendingSessionDelivery(params));
      startRuntime({ deliver, drain, log: logger });

      await scheduleSessionDelivery(id);
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
    });
  });

  it("reschedules pending entries after the runtime owner restarts", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime) => {
      const id = await enqueueSessionDelivery({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated music ready",
        messageId: "music:task-1:agent-loop",
      });
      const oldDeliver = vi.fn(async () => {});
      const stopOldRuntime = startRuntime({ deliver: oldDeliver, log: logger });
      await scheduleSessionDelivery(id);
      stopOldRuntime();
      await expect(scheduleSessionDelivery(id)).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(oldDeliver).not.toHaveBeenCalled();
      expect(await loadPendingSessionDeliveries()).toEqual([expect.objectContaining({ id })]);
      const resumedDeliver = vi.fn(async () => {});
      startRuntime({ deliver: resumedDeliver, log: logger });
      stopOldRuntime();

      await schedulePendingSessionDeliveries();
      await vi.advanceTimersByTimeAsync(0);

      expect(oldDeliver).not.toHaveBeenCalled();
      expect(resumedDeliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
    });
  });

  it("retries a transient startup pending-entry scan failure", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime) => {
      await enqueueSessionDelivery({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated music ready",
        messageId: "music:task-scan:agent-loop",
      });
      const deliver = vi.fn(async () => {});
      const listPending = vi
        .fn<typeof loadPendingSessionDeliveries>()
        .mockRejectedValueOnce(new Error("database busy"))
        .mockImplementation(() => loadPendingSessionDeliveries());
      startRuntime({ deliver, log: logger, listPending });

      await schedulePendingSessionDeliveries();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to scan"));
      expect(deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.runOnlyPendingTimersAsync();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
    });
  });
});
