// Covers same-process scheduling for durable session delivery retries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  schedulePendingSessionDeliveries,
  scheduleSessionDelivery,
  startSessionDeliveryRuntime,
} from "./session-delivery-queue-runtime.js";
import { testing } from "./session-delivery-queue-runtime.test-support.js";
import {
  drainPendingSessionDeliveries,
  enqueueClaimedSessionDelivery,
  enqueueSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  releaseSessionDeliveryClaim,
} from "./session-delivery-queue.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  testing.reset();
  vi.useRealTimers();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe("session delivery queue runtime", () => {
  it("drains a newly scheduled durable entry", async () => {
    vi.useFakeTimers();
    await withTempDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
        const id = await enqueueSessionDelivery({
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-1:agent-loop",
        });
        const deliver = vi.fn(async () => {});
        const onSettled = vi.fn(async () => {});
        const stop = startSessionDeliveryRuntime({ deliver, log: logger, onSettled });

        await expect(scheduleSessionDelivery(id)).resolves.toBe(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "recovered");
        expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
        stop();
      });
    });
  });

  it("retries a transient initial queue lookup failure", async () => {
    vi.useFakeTimers();
    await withTempDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
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
        startSessionDeliveryRuntime({ deliver, log: logger, reloadPending });

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
  });

  it("holds a claimed entry until release then rearms it immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    await withTempDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
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
        startSessionDeliveryRuntime({ deliver, log: logger });

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
  });

  it("coalesces duplicate schedules while the same entry is draining", async () => {
    vi.useFakeTimers();
    await withTempDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
        const id = await enqueueSessionDelivery({
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-in-flight:agent-loop",
        });
        let releaseDelivery: (() => void) | undefined;
        const deliver = vi.fn(
          async () =>
            await new Promise<void>((resolve) => {
              releaseDelivery = resolve;
            }),
        );
        startSessionDeliveryRuntime({ deliver, log: logger });

        await scheduleSessionDelivery(id);
        vi.advanceTimersByTime(0);
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

        await scheduleSessionDelivery(id);
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(1);

        releaseDelivery?.();
        await vi.waitFor(async () => {
          expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
        });
        expect(deliver).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("retries a failed agent turn after durable backoff", async () => {
    vi.useFakeTimers();
    await withTempDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
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
        startSessionDeliveryRuntime({ deliver, log: logger });

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
  });

  it("rearms a pending entry after a transient reload failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    await withTempDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
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
        const reloadPending = vi
          .fn<typeof loadPendingSessionDelivery>()
          .mockImplementationOnce((entryId) => loadPendingSessionDelivery(entryId))
          .mockRejectedValueOnce(new Error("database busy"))
          .mockImplementation((entryId) => loadPendingSessionDelivery(entryId));
        startSessionDeliveryRuntime({ deliver, log: logger, reloadPending });

        await scheduleSessionDelivery(id);
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to reload"));

        await vi.advanceTimersByTimeAsync(4_999);
        expect(deliver).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
      });
    });
  });

  it("backs off after a drain-level failure leaves retry metadata unchanged", async () => {
    vi.useFakeTimers();
    await withTempDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
        const id = await enqueueSessionDelivery({
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated video ready",
          messageId: "video:task-drain:agent-loop",
        });
        const deliver = vi.fn(async () => {});
        const drain = vi
          .fn<typeof drainPendingSessionDeliveries>()
          .mockRejectedValueOnce(new Error("database scan failed"))
          .mockImplementation((params) => drainPendingSessionDeliveries(params));
        startSessionDeliveryRuntime({ deliver, drain, log: logger });

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
  });

  it("backs off after a no-op drain leaves an immediately due row pending", async () => {
    vi.useFakeTimers();
    await withTempDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
        const id = await enqueueSessionDelivery({
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated video ready",
          messageId: "video:task-owned-elsewhere:agent-loop",
        });
        const deliver = vi.fn(async () => {});
        const drain = vi
          .fn<typeof drainPendingSessionDeliveries>()
          .mockResolvedValueOnce(undefined)
          .mockImplementation((params) => drainPendingSessionDeliveries(params));
        startSessionDeliveryRuntime({ deliver, drain, log: logger });

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
  });

  it("reschedules pending entries after the runtime owner restarts", async () => {
    vi.useFakeTimers();
    await withTempDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
        await enqueueSessionDelivery({
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated music ready",
          messageId: "music:task-1:agent-loop",
        });
        const oldDeliver = vi.fn(async () => {});
        const stopOldRuntime = startSessionDeliveryRuntime({ deliver: oldDeliver, log: logger });
        stopOldRuntime();
        const resumedDeliver = vi.fn(async () => {});
        startSessionDeliveryRuntime({ deliver: resumedDeliver, log: logger });

        await schedulePendingSessionDeliveries();
        await vi.advanceTimersByTimeAsync(0);

        expect(oldDeliver).not.toHaveBeenCalled();
        expect(resumedDeliver).toHaveBeenCalledTimes(1);
        expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
      });
    });
  });

  it("retries a transient startup pending-entry scan failure", async () => {
    vi.useFakeTimers();
    await withTempDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
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
        startSessionDeliveryRuntime({ deliver, log: logger, listPending });

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
});
