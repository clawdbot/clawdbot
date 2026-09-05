// Whatsapp tests cover monitor state plugin behavior.
import { describe, expect, it } from "vitest";
import { createWebChannelStatusController } from "./monitor-state.js";

describe("createWebChannelStatusController", () => {
  it("publishes the initial starting lifecycle", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.emit();

    expect(patches.at(-1)).toMatchObject({
      running: true,
      connected: false,
      healthState: "starting",
      lifecycle: "starting",
    });
  });

  it("sets lastTransportActivityAt on noteConnected", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);

    const last = patches.at(-1)!;
    expect(last.connected).toBe(true);
    expect(last.lastTransportActivityAt).toBe(1000);
    expect(last.lifecycle).toBe("ready");
  });

  it("updates lastTransportActivityAt on noteInbound", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);
    controller.noteInbound(2000);

    const last = patches.at(-1)!;
    expect(last.lastTransportActivityAt).toBe(2000);
  });

  it("updates lastTransportActivityAt from explicit transport activity", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);
    controller.noteTransportActivity(3000);

    const last = patches.at(-1)!;
    expect(last.lastTransportActivityAt).toBe(3000);
  });

  it("publishes busy state for pending inbound work", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);
    controller.noteBusy(true, 2000);
    controller.noteBusy(false, 3000);

    const busy = patches.at(-2)!;
    expect(busy.busy).toBe(true);
    expect(busy.lastRunActivityAt).toBe(2000);
    expect(busy.healthState).toBe("healthy");

    const idle = patches.at(-1)!;
    expect(idle.busy).toBe(false);
    expect(idle.lastRunActivityAt).toBe(3000);
  });

  it("does not set lastTransportActivityAt on noteWatchdogStale", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);
    controller.noteWatchdogStale(5000);

    const last = patches.at(-1)!;
    // Watchdog staleness should not refresh transport activity — it means
    // the check loop is running but the socket itself is idle/stale.
    expect(last.lastTransportActivityAt).toBe(1000);
    expect(last.healthState).toBe("stale");
    expect(last.lifecycle).toBe("recovering");
  });

  it("produces snapshots that enable stale-socket health detection", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);

    const last = patches.at(-1)!;
    // The gateway health policy checks `connected === true && lastTransportActivityAt != null`
    // to decide whether to run stale-socket detection. Both must be present.
    expect(last.connected).toBe(true);
    expect(last.lastTransportActivityAt).toBe(1000);
  });

  it("clears watchdog recovery history once the socket is healthy again", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);
    controller.noteClose({
      at: 2000,
      statusCode: 499,
      error: "status=499",
      reconnectAttempts: 1,
      healthState: "reconnecting",
      watchdogRecovery: true,
    });
    expect(patches.at(-1)!.lastDisconnect).toEqual({
      at: 2000,
      status: 499,
      error: "status=499",
      loggedOut: false,
    });
    controller.noteConnected(3000);

    const last = patches.at(-1)!;
    expect(last.connected).toBe(true);
    expect(last.healthState).toBe("healthy");
    expect(last.reconnectAttempts).toBe(0);
    expect(last.lastDisconnect).toBeNull();
  });

  it("keeps non-watchdog reconnect history after the socket reconnects", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);
    controller.noteClose({
      at: 2000,
      statusCode: 408,
      error: "status=408",
      reconnectAttempts: 1,
      healthState: "reconnecting",
    });
    controller.noteConnected(3000);

    const last = patches.at(-1)!;
    expect(last.connected).toBe(true);
    expect(last.healthState).toBe("healthy");
    expect(last.reconnectAttempts).toBe(1);
    expect(last.lastDisconnect).toEqual({
      at: 2000,
      status: 408,
      error: "status=408",
      loggedOut: false,
    });
  });

  it.each([
    {
      healthState: "logged-out",
      statusCode: 401,
      error: "WhatsApp session logged out",
      reconnectAttempts: 0,
      lifecycle: "blocked",
      finalHealthState: "logged-out",
      finalLifecycle: "blocked",
      terminalDisconnect: true,
    },
    {
      healthState: "conflict",
      statusCode: 440,
      error: "WhatsApp session conflict",
      reconnectAttempts: 0,
      lifecycle: "blocked",
      finalHealthState: "conflict",
      finalLifecycle: "blocked",
      terminalDisconnect: true,
    },
    {
      healthState: "stopped",
      statusCode: 408,
      error: "WhatsApp reconnect attempts exhausted after a timeout",
      reconnectAttempts: 12,
      lifecycle: "blocked",
      finalHealthState: "stopped",
      finalLifecycle: "blocked",
      terminalDisconnect: true,
    },
    {
      healthState: "reconnecting",
      statusCode: 408,
      error: "WhatsApp connection timed out",
      reconnectAttempts: 1,
      lifecycle: "recovering",
      finalHealthState: "stopped",
      finalLifecycle: "stopped",
      terminalDisconnect: false,
    },
  ] as const)(
    "publishes lifecycle=$lifecycle and terminalDisconnect=$terminalDisconnect after a $healthState stop",
    ({
      healthState,
      statusCode,
      error,
      reconnectAttempts,
      lifecycle,
      finalHealthState,
      finalLifecycle,
      terminalDisconnect,
    }) => {
      const patches: Record<string, unknown>[] = [];
      const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

      controller.noteConnected(1000);
      controller.noteClose({
        at: 2000,
        statusCode,
        error,
        reconnectAttempts,
        healthState,
      });
      expect(patches.at(-1)!.healthState).toBe(healthState);
      expect(patches.at(-1)!.lifecycle).toBe(lifecycle);

      const stoppedStatus = {
        healthState: finalHealthState,
        lifecycle: finalLifecycle,
        terminalDisconnect,
        lastError: error,
        reconnectAttempts,
        lastDisconnect: {
          at: 2000,
          status: statusCode,
          error,
        },
      };

      controller.markStopped(2100);
      expect(patches.at(-1)).toMatchObject(stoppedStatus);

      controller.markStopped(2200);
      expect(patches.at(-1)).toMatchObject(stoppedStatus);
    },
  );

  it.each([
    { healthState: "logged-out", statusCode: 401, reconnectAttempts: 0 },
    { healthState: "conflict", statusCode: 440, reconnectAttempts: 0 },
    { healthState: "stopped", statusCode: 408, reconnectAttempts: 12 },
  ] as const)(
    "clears terminalDisconnect on reconnect after a $healthState stop",
    ({ healthState, statusCode, reconnectAttempts }) => {
      const patches: Record<string, unknown>[] = [];
      const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

      controller.noteConnected(1000);
      controller.noteClose({
        at: 2000,
        statusCode,
        error: healthState,
        reconnectAttempts,
        healthState,
      });
      controller.markStopped(2100);
      expect(patches.at(-1)!.terminalDisconnect).toBe(true);
      expect(patches.at(-1)!.lifecycle).toBe("blocked");

      controller.markStopped(2200);
      expect(patches.at(-1)!.terminalDisconnect).toBe(true);
      expect(patches.at(-1)!.lifecycle).toBe("blocked");

      controller.noteConnected(3000);
      expect(patches.at(-1)!.terminalDisconnect).toBeUndefined();
      expect(patches.at(-1)!.healthState).toBe("healthy");
      expect(patches.at(-1)!.lifecycle).toBe("ready");

      controller.markStopped(3100);
      expect(patches.at(-1)).toMatchObject({
        healthState: "stopped",
        lifecycle: "stopped",
        terminalDisconnect: false,
      });

      controller.markStopped(3200);
      expect(patches.at(-1)).toMatchObject({
        healthState: "stopped",
        lifecycle: "stopped",
        terminalDisconnect: false,
      });
    },
  );

  it("publishes stopped lifecycle without changing the shipped health label", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);
    controller.markStopped(2000);

    expect(patches.at(-1)).toMatchObject({
      running: false,
      connected: false,
      healthState: "stopped",
      lifecycle: "stopped",
      terminalDisconnect: false,
    });

    controller.markStopped(3000);
    expect(patches.at(-1)).toMatchObject({
      healthState: "stopped",
      lifecycle: "stopped",
      terminalDisconnect: false,
    });
  });
});
