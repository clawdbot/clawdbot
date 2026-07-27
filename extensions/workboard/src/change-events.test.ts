import type { WorkboardChange } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardChangeEventService } from "./change-events.js";
import type { WorkboardStore } from "./store.js";

afterEach(() => vi.useRealTimers());

describe("createWorkboardChangeEventService", () => {
  it("announces its epoch, forwards changes, and reconciles external commits", async () => {
    vi.useFakeTimers();
    let listener: ((change: WorkboardChange) => void) | undefined;
    const unsubscribe = vi.fn();
    const reconcileExternalChanges = vi.fn();
    const store = {
      subscribeChanges: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
      announceChangeEpoch: vi.fn(() => listener?.({ epoch: "epoch-a", revision: 1 })),
      reconcileExternalChanges,
    } as unknown as WorkboardStore;
    const emit = vi.fn();
    const warn = vi.fn();
    const service = createWorkboardChangeEventService(store);
    const context = {
      config: {},
      stateDir: "/tmp/workboard-change-events-test",
      gatewayEvents: { emit },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    } satisfies Parameters<typeof service.start>[0];

    await service.start(context);
    listener?.({ epoch: "epoch-a", revision: 2 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(emit.mock.calls).toEqual([
      ["changed", { epoch: "epoch-a", revision: 1 }, { scope: "operator.read" }],
      ["changed", { epoch: "epoch-a", revision: 2 }, { scope: "operator.read" }],
    ]);
    expect(reconcileExternalChanges).toHaveBeenCalledOnce();
    await service.stop?.(context);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcileExternalChanges).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs external reconciliation failures without stopping the service", async () => {
    vi.useFakeTimers();
    const reconcileExternalChanges = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const store = {
      subscribeChanges: vi.fn(() => vi.fn()),
      announceChangeEpoch: vi.fn(),
      reconcileExternalChanges,
    } as unknown as WorkboardStore;
    const warn = vi.fn();
    const service = createWorkboardChangeEventService(store);
    const context = {
      config: {},
      stateDir: "/tmp/workboard-change-events-test",
      gatewayEvents: { emit: vi.fn() },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    } satisfies Parameters<typeof service.start>[0];

    await service.start(context);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reconcileExternalChanges).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    await service.stop?.(context);
  });
});
