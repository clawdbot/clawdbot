// Covers session delivery queue recovery behavior.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
const RECOVERY_REPLAY_SPACING_MS = 250;
import {
  failSessionDelivery,
  loadPendingSessionDeliveries,
} from "./session-delivery-queue-storage.js";
import {
  drainPendingSessionDeliveries,
  enqueueSessionDelivery,
  recoverPendingSessionDeliveries,
} from "./session-delivery-queue.js";

describe("session-delivery queue recovery", () => {
  it("replays and acks pending entries on recovery", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "restart complete",
        },
        tempDir,
      );

      const deliver = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);
    });
  });

  it("paces startup replay for multiple eligible session deliveries", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
        await enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "first",
          },
          tempDir,
        );
        await enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "second",
          },
          tempDir,
        );

        let firstDelivered!: () => void;
        const firstDeliveredPromise = new Promise<void>((resolve) => {
          firstDelivered = resolve;
        });
        const deliveryTimes: number[] = [];
        const deliver = vi.fn(async () => {
          deliveryTimes.push(Date.now());
          if (deliveryTimes.length === 1) {
            firstDelivered();
          }
        });

        const recovery = recoverPendingSessionDeliveries({
          deliver,
          stateDir: tempDir,
          log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
        });
        await firstDeliveredPromise;
        expect(deliver).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(RECOVERY_REPLAY_SPACING_MS - 1);
        expect(deliver).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        const summary = await recovery;

        expect(deliver).toHaveBeenCalledTimes(2);
        expect(deliveryTimes[1]).toBe(startedAt.getTime() + RECOVERY_REPLAY_SPACING_MS);
        expect(summary.recovered).toBe(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts replay pacing against the session recovery budget", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
        for (const text of ["first", "second", "third"]) {
          await enqueueSessionDelivery(
            {
              kind: "systemEvent",
              sessionKey: "agent:main:main",
              text,
            },
            tempDir,
          );
        }

        let firstDelivered!: () => void;
        const firstDeliveredPromise = new Promise<void>((resolve) => {
          firstDelivered = resolve;
        });
        const deliveryTimes: number[] = [];
        const deliver = vi.fn(async () => {
          deliveryTimes.push(Date.now());
          if (deliveryTimes.length === 1) {
            firstDelivered();
          }
        });

        const recovery = recoverPendingSessionDeliveries({
          deliver,
          stateDir: tempDir,
          maxRecoveryMs: 1,
          log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
        });
        await firstDeliveredPromise;

        await vi.advanceTimersByTimeAsync(1);
        const summary = await recovery;

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliveryTimes).toEqual([startedAt.getTime()]);
        expect(summary.recovered).toBe(1);
        expect(await loadPendingSessionDeliveries(tempDir)).toHaveLength(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers recovery when the recovery budget would exceed the date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "leave queued",
        },
        tempDir,
      );

      const deliver = vi.fn(async () => undefined);
      const warn = vi.fn();
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        stateDir: tempDir,
        maxRecoveryMs: 1,
        log: {
          info: vi.fn(),
          warn,
          error: vi.fn(),
        },
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "Session delivery recovery time budget exceeded — remaining entries deferred",
      );
      expect(summary.recovered).toBe(0);
      expect(await loadPendingSessionDeliveries(tempDir)).toHaveLength(1);
    });

    vi.useRealTimers();
  });

  it("keeps failed entries queued with retry metadata for later recovery", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
        },
        tempDir,
      );

      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => {
          throw new Error("transient failure");
        }),
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      const [failedEntry] = await loadPendingSessionDeliveries(tempDir);
      expect(summary.failed).toBe(1);
      expect(failedEntry?.retryCount).toBe(1);
      expect(failedEntry?.lastError).toBe("transient failure");
    });
  });

  it("uses the entry retry budget when draining entries", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          maxRetries: 20,
        },
        tempDir,
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await failSessionDelivery(id, "busy", tempDir);
      }

      const deliver = vi.fn(async () => undefined);
      await drainPendingSessionDeliveries({
        drainKey: "test-restart-continuation",
        logLabel: "test restart continuation",
        deliver,
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        selectEntry: (entry) => ({
          match: entry.id === id,
          bypassBackoff: true,
        }),
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });

  it("skips entries queued after the startup recovery cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "recover old entry",
        },
        tempDir,
      );
      const maxEnqueuedAt = Date.now();

      vi.setSystemTime(new Date("2026-04-23T00:00:05.000Z"));
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "leave fresh entry queued",
        },
        tempDir,
      );

      const deliver = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        stateDir: tempDir,
        maxEnqueuedAt,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      const pending = await loadPendingSessionDeliveries(tempDir);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.kind).toBe("systemEvent");
      if (pending[0]?.kind === "systemEvent") {
        expect(pending[0].text).toBe("leave fresh entry queued");
      }
    });

    vi.useRealTimers();
  });
});
