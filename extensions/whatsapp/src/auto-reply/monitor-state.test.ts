// Whatsapp tests cover monitor state plugin behavior.
import { describe, expect, it } from "vitest";
import { createWebChannelStatusController } from "./monitor-state.js";

describe("createWebChannelStatusController", () => {
  it("sets lastTransportActivityAt on noteConnected", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);

    const last = patches.at(-1)!;
    expect(last.connected).toBe(true);
    expect(last.lastTransportActivityAt).toBe(1000);
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
    { healthState: "logged-out", statusCode: 401, terminalDisconnect: true },
    { healthState: "conflict", statusCode: 440, terminalDisconnect: true },
    { healthState: "reconnecting", statusCode: 408, terminalDisconnect: false },
  ] as const)(
    "sets terminalDisconnect=$terminalDisconnect after a $healthState stop",
    ({ healthState, statusCode, terminalDisconnect }) => {
      const patches: Record<string, unknown>[] = [];
      const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

      controller.noteConnected(1000);
      controller.noteClose({
        at: 2000,
        statusCode,
        error: healthState,
        reconnectAttempts: healthState === "reconnecting" ? 1 : 0,
        healthState,
      });
      controller.markStopped(2100);

      expect(patches.at(-1)!.terminalDisconnect).toBe(terminalDisconnect);
    },
  );

  it("clears terminalDisconnect on noteConnected after a terminal stop", () => {
    const patches: Record<string, unknown>[] = [];
    const controller = createWebChannelStatusController((s) => patches.push({ ...s }));

    controller.noteConnected(1000);
    controller.noteClose({
      at: 2000,
      statusCode: 401,
      error: "logged out",
      reconnectAttempts: 0,
      healthState: "logged-out",
    });
    controller.markStopped(2100);
    expect(patches.at(-1)!.terminalDisconnect).toBe(true);

    controller.noteConnected(3000);
    expect(patches.at(-1)!.terminalDisconnect).toBeUndefined();
  });
});
