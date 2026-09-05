import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { scheduleGatewayIdleTask } from "./server-idle-task.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { scheduleContextCachePrewarm } from "./server-startup-context-cache-prewarm.js";
import { scheduleGatewayHandlerPrewarm } from "./server-startup-handler-prewarm.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

afterEach(() => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

it.each(["idle", "handler", "context"] as const)(
  "joins started %s work before the Gateway sidecar owner closes",
  async (kind) => {
    vi.useFakeTimers();
    const released = createDeferred();
    const events: string[] = [];
    const run = async () => {
      events.push("started");
      await released.promise;
      events.push("finished");
    };
    const log = { warn: vi.fn() };
    const later = vi.fn(async () => {});
    const handle =
      kind === "idle"
        ? scheduleGatewayIdleTask({
            delayMs: 0,
            retryDelayMs: 1,
            isClosing: () => false,
            isBusy: () => false,
            run,
            log,
            errorMessage: "idle lifecycle test failed",
          })
        : kind === "handler"
          ? scheduleGatewayHandlerPrewarm({
              cfgAtStart: {},
              log,
              items: [
                { name: "first", load: run },
                { name: "later", load: later },
              ],
            })
          : scheduleContextCachePrewarm({
              getConfig: () => ({}),
              log,
              startupTrace: {
                measure: async (_name, warm) => {
                  await run();
                  return warm();
                },
              },
            });
    let registered: GatewayPostReadySidecarHandle[] = [handle];
    const owner = createGatewaySidecarStopOwner({
      getRegistered: () => registered,
      setRegistered: (next) => {
        registered = next;
      },
    });
    let stopping: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(kind === "context" ? 5_000 : 0);
      expect([...events]).toEqual(["started"]);
      owner.beginClose();
      stopping = owner.stop().then(() => {
        events.push("closed");
      });
      await vi.advanceTimersByTimeAsync(0);
      expect([...events]).toEqual(["started"]);
    } finally {
      owner.beginClose();
      stopping ??= owner.stop();
      released.resolve();
      await stopping;
    }
    expect(events).toEqual(["started", "finished", "closed"]);
    expect(later).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  },
);

it.each(["suspension", "restart signal"] as const)(
  "stops idle work without reopening the %s fence",
  async (kind) => {
    vi.useFakeTimers();
    const suspension = kind === "suspension" ? tryBeginGatewaySuspendAdmission(() => {}) : null;
    const restart = kind === "restart signal" ? beginGatewayRestartSignalAdmission() : null;
    expect(suspension?.commit() ?? Boolean(restart)).toBe(true);
    const run = vi.fn(async () => {});
    const handle = scheduleGatewayIdleTask({
      delayMs: 0,
      retryDelayMs: 10,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: { warn: vi.fn() },
      errorMessage: "idle task failed",
    });
    let stopping: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      let closed = false;
      stopping = Promise.resolve(handle.stop()).then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(true);
      expect(run).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      const closing = handle.stop();
      suspension?.release();
      restart?.rollback();
      await closing;
      await stopping;
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(run).not.toHaveBeenCalled();
  },
);

it("joins the outgoing handler when shutdown begins in its warning callback", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const later = vi.fn(async () => {});
  let rootsAfterStop: number | undefined;
  let stopping: Promise<void> | undefined;
  const warn = vi.fn(() => {
    events.push("warning");
    stopping = Promise.resolve(sidecar.stop()).then(() => {
      rootsAfterStop = getActiveGatewayRootWorkCount();
      events.push("closed");
    });
  });
  const sidecar = scheduleGatewayHandlerPrewarm({
    cfgAtStart: {},
    log: { warn },
    items: [
      {
        name: "first",
        load: async () => {
          events.push("started");
          throw new Error("cold load failed");
        },
      },
      { name: "later", load: later },
    ],
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    expect(warn).toHaveBeenCalledOnce();
    expect(events).toEqual(["started", "warning", "closed"]);
    expect(rootsAfterStop).toBe(0);
    expect(later).not.toHaveBeenCalled();
  } finally {
    await sidecar.stop();
    await stopping;
  }
});
