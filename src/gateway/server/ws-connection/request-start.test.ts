import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleGatewayRequestStart } from "./request-start.js";

const permissions: Promise<void>[] = [];
function requestStart(bytes = 1): Promise<void> {
  const permission = scheduleGatewayRequestStart(bytes);
  if (!permission) {
    throw new Error("expected start capacity");
  }
  permissions.push(permission);
  return permission;
}

afterEach(async () => {
  await Promise.all(permissions.splice(0));
  vi.restoreAllMocks();
});

describe("Gateway request start fairness", () => {
  it("releases cheap starts in FIFO order without waiting for their work to finish", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const starts: number[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = requestStart().then(async () => {
      starts.push(0);
      await held;
    });
    const rest = Array.from({ length: 32 }, (_, index) =>
      requestStart().then(() => {
        starts.push(index + 1);
      }),
    );
    try {
      await Promise.all(rest);
      expect(starts).toEqual(Array.from({ length: 33 }, (_, index) => index));
    } finally {
      release();
      await first;
    }
  });

  it.each([false, true])(
    "yields after actual caller work (ready continuation: %s)",
    async (continuation) => {
      let workClock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => workClock);
      const events: string[] = [];
      let sentinel: Promise<void> | undefined;
      const first = requestStart().then(async () => {
        if (continuation) {
          await Promise.resolve();
        }
        events.push("first");
        workClock += 20;
        sentinel = nextTurn().then(() => {
          events.push("yield");
        });
      });
      const second = requestStart().then(() => {
        events.push("second");
      });
      await Promise.all([first, second]);
      await sentinel;
      expect(events).toEqual(["first", "yield", "second"]);
    },
  );

  it("bounds zero-cost starts per turn even when elapsed work stays zero", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const starts: number[] = [];
    let seenAtYield: number | undefined;
    let sentinel: Promise<void> | undefined;
    const callers = Array.from({ length: 65 }, (_, index) =>
      requestStart().then(() => {
        starts.push(index);
        if (index === 0) {
          sentinel = nextTurn().then(() => {
            seenAtYield = starts.length;
          });
        }
      }),
    );
    await Promise.all(callers);
    await sentinel;
    expect(seenAtYield).toBe(64);
    expect(starts).toEqual(Array.from({ length: 65 }, (_, index) => index));
  });

  it("rejects count overflow without starting it inline and releases waiting capacity", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const accepted = Array.from({ length: 257 }, () => requestStart());
    expect(scheduleGatewayRequestStart(1)).toBeNull();
    await Promise.all(accepted);
    await expect(requestStart()).resolves.toBeUndefined();
  });

  it("accounts the original serialized bytes independently of frame count", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const first = requestStart(25 * 1024 * 1024);
    const second = requestStart(25 * 1024 * 1024);
    const third = requestStart(25 * 1024 * 1024);
    expect(scheduleGatewayRequestStart(1)).toBeNull();
    await Promise.all([first, second, third]);
    await expect(requestStart(25 * 1024 * 1024)).resolves.toBeUndefined();
  });
});
