import { describe, expect, it, vi } from "vitest";
import {
  computeBackoff,
  computeBackoffSchedule,
  createRetryRunner,
  RetrySupervisor,
  retryAsync,
  sleepWithAbort,
} from "./index.js";

describe("RetrySupervisor", () => {
  it("owns attempt counting, overrides, rebasing, and exhaustion", () => {
    const supervisor = new RetrySupervisor({ initialMs: 100, maxMs: 250, factor: 2, jitter: 0 }, 2);

    const first = supervisor.next();
    expect(first).toMatchObject({ attempt: 1, delayMs: 100 });

    supervisor.nextDelayOverrideMs = 175;
    const override = supervisor.next();
    expect(override).toMatchObject({ attempt: 1, delayMs: 175 });

    const second = supervisor.next();
    expect(second).toMatchObject({ attempt: 2, delayMs: 200 });
    expect(supervisor.next()).toBeUndefined();
    expect(supervisor.attempts).toBe(3);

    supervisor.reset(25);
    expect(supervisor.next()).toMatchObject({ attempt: 1, delayMs: 25 });
  });

  it("uses exact capped schedules", () => {
    expect(
      [0, 1, 2, 3, 4, 5].map((attempt) => computeBackoffSchedule([5, 25, 120], attempt)),
    ).toEqual([0, 5, 25, 120, 120, 120]);
  });

  it("keeps long-lived exponential backoff at its cap", () => {
    expect(computeBackoff({ initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0 }, 1_016)).toBe(
      30_000,
    );
  });

  it("cancels a pending wait with the canonical abort error", async () => {
    vi.useFakeTimers();
    try {
      const supervisor = new RetrySupervisor({
        initialMs: 100,
        maxMs: 100,
        factor: 2,
        jitter: 0,
      });
      const retry = supervisor.next();
      const wait = sleepWithAbort(retry?.delayMs ?? 0, retry?.signal);
      supervisor.cancel(new Error("stop"));

      await expect(wait).rejects.toMatchObject({ message: "aborted" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retryAsync", () => {
  it.each([0, 0.5])(
    "never rounds an honorable Retry-After below its floor with jitter=%s",
    async (jitter) => {
      const sleeps: number[] = [];
      const run = createRetryRunner({ sleep: async (ms) => void sleeps.push(ms) });
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("rate limited"))
        .mockResolvedValueOnce("ok");

      await expect(
        run(operation, {
          attempts: 2,
          minDelayMs: 0,
          maxDelayMs: 10,
          jitter,
          random: () => 0,
          retryAfterMs: () => 1.4,
        }),
      ).resolves.toBe("ok");
      expect(sleeps).toEqual([2]);
    },
  );

  it("supports custom schedules, abortable sleeps, and async retry hooks", async () => {
    const events: string[] = [];
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce("ok");

    await expect(
      retryAsync(operation, {
        attempts: 3,
        minDelayMs: 0,
        maxDelayMs: 100,
        delayMs: ({ attempt }) => [10, 30][attempt - 1] ?? 0,
        onRetry: async ({ attempt }) => void events.push(`retry:${attempt}`),
        sleep: async (ms) => void events.push(`sleep:${ms}`),
      }),
    ).resolves.toBe("ok");
    expect(events).toEqual(["retry:1", "sleep:10", "retry:2", "sleep:30"]);
  });

  it("preserves terminal Error identity", async () => {
    const terminal = new Error("terminal");
    await expect(
      retryAsync(
        async () => {
          throw terminal;
        },
        {
          attempts: 1,
        },
      ),
    ).rejects.toBe(terminal);
  });

  it("clamps numeric overload delays to the Node timer ceiling", async () => {
    const sleeps: number[] = [];
    const run = createRetryRunner({ sleep: async (ms) => void sleeps.push(ms) });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce("ok");

    await run(operation, 2, Number.POSITIVE_INFINITY);
    expect(sleeps).toEqual([2_147_000_000]);
  });
});
