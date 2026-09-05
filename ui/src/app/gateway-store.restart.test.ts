// @vitest-environment node
// Restart-aware connection state: shutdown broadcast, drain rejection, deadline.
// Split from gateway-store.test.ts to respect the max-lines cap.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore as createStore,
  GATEWAY_STORE_TEST_HELLO as HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";

describe("createApplicationGateway restart state", () => {
  beforeEach(() => {
    stubGatewayStoreTestGlobals();
  });

  afterEach(() => {
    setAvatarGatewayOrigin(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("projects suspension hello/events without changing transport and drops stale connection state", () => {
    const { gateway, current } = createStore();
    gateway.start();
    const first = current();
    const suspendedHello = { ...HELLO, snapshot: { suspension: { phase: "prepared" } } };
    try {
      first.opts.onHello?.(suspendedHello);
      expect(gateway.snapshot.suspensionPhase).toBe("prepared");
      for (const phase of [
        "accepting",
        "preparing",
        "draining",
        "prepared",
        "accepting",
      ] as const) {
        first.opts.onEvent?.(createGatewayEvent("gateway.suspension", { phase }));
        expect(gateway.snapshot.suspensionPhase).toBe(phase);
        expect(gateway.snapshot.phase).toBe("connected");
      }
      first.opts.onEvent?.(createGatewayEvent("gateway.suspension", { phase: "resuming" }));
      expect(gateway.snapshot.suspensionPhase).toBe("accepting");
      first.opts.onHello?.(suspendedHello);
      first.opts.onClose?.({ code: 1006, reason: "offline", willRetry: true });
      expect(gateway.snapshot.suspensionPhase).toBeUndefined();
      gateway.connect();
      first.opts.onEvent?.(createGatewayEvent("gateway.suspension", { phase: "prepared" }));
      expect(gateway.snapshot.suspensionPhase).toBeUndefined();
      current().opts.onHello?.(HELLO);
      expect(gateway.snapshot.suspensionPhase).toBeUndefined();
    } finally {
      gateway.stop();
    }
  });

  it("publishes shutdown immediately while connected and clears it after the next hello", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    current().opts.onEvent?.(
      createGatewayEvent("shutdown", { reason: "gateway restart", restartExpectedMs: 8_000 }),
    );
    expect(gateway.snapshot.phase).toBe("connected");
    expect(gateway.snapshot.restartPending).toBe(true);
    current().opts.onClose?.({ code: 1012, reason: "gateway restarting", willRetry: true });
    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.restartPending).toBe(false);
  });

  it.each([
    { restartExpectedMs: 1_000, deadlineMs: 15_000 },
    { restartExpectedMs: 8_000, deadlineMs: 24_000 },
  ])(
    "degrades an overdue restart to stable offline after $deadlineMs ms",
    async ({ restartExpectedMs, deadlineMs }) => {
      vi.useFakeTimers();
      const { gateway, current } = createStore();
      gateway.start();
      current().opts.onHello?.(HELLO);
      current().opts.onEvent?.(
        createGatewayEvent("shutdown", { reason: "gateway restart", restartExpectedMs }),
      );
      current().opts.onClose?.({ code: 1012, reason: "gateway restarting", willRetry: true });

      await vi.advanceTimersByTimeAsync(deadlineMs - 1);
      expect(gateway.snapshot.restartPending).toBe(true);
      expect(gateway.snapshot.offlineStable).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(gateway.snapshot.restartPending).toBe(false);
      expect(gateway.snapshot.offlineStable).toBe(true);
    },
  );

  it("keeps an ordinary stop on the offline pill path (no restart state)", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    current().opts.onEvent?.(createGatewayEvent("shutdown", { reason: "gateway stopping" }));
    expect(gateway.snapshot.restartPending).toBeFalsy();
    current().opts.onClose?.({ code: 1001, reason: "gateway stopping", willRetry: true });
    expect(gateway.snapshot.restartPending).toBeFalsy();
    expect(gateway.snapshot.phase).toBe("reconnecting");
  });

  it("recognizes the structured restart rejection before the first successful hello", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({
      code: 1013,
      reason: "gateway restart in progress",
      willRetry: true,
      error: {
        code: "UNAVAILABLE",
        message: "connect unavailable during gateway restart",
        details: { reason: "gateway-restarting" },
      },
    });
    expect(gateway.snapshot.phase).toBe("connecting");
    expect(gateway.snapshot.restartPending).toBe(true);
  });

  it("clears the pending restart deadline when stopped", async () => {
    vi.useFakeTimers();
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    current().opts.onEvent?.(
      createGatewayEvent("shutdown", { reason: "gateway restart", restartExpectedMs: 1_000 }),
    );

    gateway.stop();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(gateway.snapshot.phase).toBe("stopped");
    expect(gateway.snapshot.restartPending).toBe(false);
  });
});
