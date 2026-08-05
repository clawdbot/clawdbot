import type {
  OpenClawPluginGatewayEvents,
  OpenClawPluginSessionsChangedEvent,
} from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./service-test-support.js";

function createGatewayEventsHarness() {
  const handlers = new Set<(event: OpenClawPluginSessionsChangedEvent) => void>();
  const unsubscribe = vi.fn();
  const gatewayEvents = {
    emit: vi.fn(),
    onSessionsChanged: vi.fn((handler) => {
      handlers.add(handler);
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        handlers.delete(handler);
        unsubscribe();
      };
    }),
  } satisfies OpenClawPluginGatewayEvents;
  return {
    gatewayEvents,
    unsubscribe,
    emit(event: OpenClawPluginSessionsChangedEvent) {
      for (const handler of handlers) {
        handler(event);
      }
    },
  };
}

describe("ClickClack discussion session events", () => {
  it("runs one catch-up reconciliation when gateway events bind", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Catch up" });
    const sessionKey = "agent:main:event-catch-up";
    try {
      await harness.service.open(sessionKey);
      const reconcile = vi.spyOn(harness.service, "reconcile").mockResolvedValue(undefined);

      harness.service.bindGatewayEvents(gateway.gatewayEvents);
      await vi.advanceTimersByTimeAsync(0);

      expect(reconcile).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledWith(sessionKey);
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("reconciles a renamed bound session from sessions.changed", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness(
      { label: "Original", category: "Projects" },
      { gatewayEvents: gateway.gatewayEvents },
    );
    const sessionKey = "agent:main:event-rename";
    try {
      await harness.service.open(sessionKey);
      harness.updateChannel.mockClear();
      harness.setSessionEntry({ label: "Renamed", category: "Projects" });

      gateway.emit({ sessionKey, label: "Renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(249);
      expect(harness.updateChannel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(harness.updateChannel).toHaveBeenCalledOnce();
      expect(harness.updateChannel).toHaveBeenCalledWith(
        "chn_discussion",
        expect.objectContaining({ display_title: "Renamed", name: "renamed" }),
      );
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("debounces sessions.changed bursts per bound session", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Burst" }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = "agent:main:event-burst";
    try {
      await harness.service.open(sessionKey);
      const reconcile = vi.spyOn(harness.service, "reconcile").mockResolvedValue(undefined);

      // Coalescing keeps the earliest scheduled run: bursts collapse into one
      // reconcile per window, and steady event traffic cannot postpone it.
      gateway.emit({ sessionKey, phase: "message" });
      await vi.advanceTimersByTimeAsync(100);
      gateway.emit({ sessionKey, phase: "message" });
      await vi.advanceTimersByTimeAsync(100);
      gateway.emit({ sessionKey, label: "Burst renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(49);
      expect(reconcile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(reconcile).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledWith(sessionKey);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconcile).toHaveBeenCalledOnce();
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("retries a failed event reconciliation once without polling bindings", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Retry" }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = "agent:main:event-retry";
    try {
      await harness.service.open(sessionKey);
      harness.updateChannel.mockClear();
      harness.updateChannel.mockRejectedValueOnce(new Error("temporary outage"));
      harness.setSessionEntry({ label: "Retry renamed" });

      gateway.emit({ sessionKey, label: "Retry renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.updateChannel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(999);
      expect(harness.updateChannel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      expect(harness.updateChannel).toHaveBeenCalledTimes(2);
      expect(harness.updateChannel).toHaveBeenLastCalledWith(
        "chn_discussion",
        expect.objectContaining({ display_title: "Retry renamed", name: "retry-renamed" }),
      );
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("unsubscribes and cancels event reconciliation during cleanup", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Cleanup" }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = "agent:main:event-cleanup";
    try {
      await harness.service.open(sessionKey);
      const reconcile = vi.spyOn(harness.service, "reconcile").mockResolvedValue(undefined);
      gateway.emit({ sessionKey, phase: "message" });
      harness.service.cleanup();
      await vi.advanceTimersByTimeAsync(250);
      gateway.emit({ sessionKey, reason: "rename" });
      await vi.advanceTimersByTimeAsync(250);

      expect(gateway.unsubscribe).toHaveBeenCalledOnce();
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("defers events arriving during a failing reconcile to the backoff floor", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Slow" }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = "agent:main:event-slow-failure";
    try {
      await harness.service.open(sessionKey);
      let rejectInFlight: ((error: Error) => void) | undefined;
      const reconcile = vi.spyOn(harness.service, "reconcile").mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectInFlight = reject;
          }),
      );

      gateway.emit({ sessionKey, label: "Slow renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(250);
      expect(reconcile).toHaveBeenCalledOnce();

      // Event during the in-flight run: must not arm a fresh 250ms timer that
      // would outlive (and undercut) the failure's backoff floor.
      gateway.emit({ sessionKey, label: "Slow renamed again", reason: "rename" });
      reconcile.mockResolvedValue(undefined);
      rejectInFlight?.(new Error("outage"));
      await vi.advanceTimersByTimeAsync(999);
      expect(reconcile).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("does not poll bindings after a successful open while events are bound", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness(
      { label: "No poll" },
      { gatewayEvents: gateway.gatewayEvents, startTimer: true },
    );
    try {
      await harness.service.open("agent:main:no-poll");
      const reconcileAll = vi.spyOn(harness.service, "reconcileAll");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).not.toHaveBeenCalled();
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("keeps polling bindings when no gateway event subscription exists", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ label: "Poll fallback" }, { startTimer: true });
    try {
      await harness.service.open("agent:main:poll-fallback");
      const reconcileAll = vi.spyOn(harness.service, "reconcileAll").mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      // Broadcaster-less runtimes never receive sessions.changed; without the
      // interval poll their bindings would never reconcile renames or archives.
      expect(reconcileAll).toHaveBeenCalled();
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("ignores settle callbacks from a superseded activation after restart", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayEventsHarness();
    const harness = createHarness({ label: "Stale" }, { gatewayEvents: gateway.gatewayEvents });
    const sessionKey = "agent:main:event-stale-settle";
    try {
      await harness.service.open(sessionKey);
      let resolveOld: (() => void) | undefined;
      const reconcile = vi
        .spyOn(harness.service, "reconcile")
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockImplementation(() => new Promise<void>(() => {}));

      gateway.emit({ sessionKey, label: "Stale renamed", reason: "rename" });
      await vi.advanceTimersByTimeAsync(250);
      expect(reconcile).toHaveBeenCalledOnce();

      // Restart while the old reconcile is mid-flight; its settle callbacks
      // must not clear the new activation's in-flight marker.
      harness.service.cleanup();
      harness.service.bindGatewayEvents(gateway.gatewayEvents);
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcile).toHaveBeenCalledTimes(2);

      resolveOld?.();
      await vi.advanceTimersByTimeAsync(0);
      gateway.emit({ sessionKey, label: "Stale renamed again", reason: "rename" });
      await vi.advanceTimersByTimeAsync(1_000);
      // The catch-up run is still in flight, so the event coalesces instead of
      // arming a third reconcile through corrupted bookkeeping.
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("recovers the fallback poll after a broadcaster-less stop/start cycle", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ label: "Restart" }, { startTimer: true });
    try {
      await harness.service.open("agent:main:poll-restart");
      harness.service.cleanup();
      harness.service.bindGatewayEvents(undefined);
      const reconcileAll = vi.spyOn(harness.service, "reconcileAll").mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).toHaveBeenCalled();
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });

  it("keeps the interval while an ambiguous discussion open is pending", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ label: "Pending retry" }, { startTimer: true });
    try {
      harness.createChannel.mockRejectedValueOnce(new Error("ambiguous create"));
      await expect(harness.service.open("agent:main:pending-retry")).rejects.toThrow(
        "ambiguous create",
      );
      const reconcileAll = vi.spyOn(harness.service, "reconcileAll").mockResolvedValue(undefined);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileAll).toHaveBeenCalledOnce();
    } finally {
      harness.service.cleanup();
      vi.useRealTimers();
    }
  });
});
