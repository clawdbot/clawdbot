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
    expect(last.lastTransportActivityAt).not.toBeNull();
    expect(typeof last.lastTransportActivityAt).toBe("number");
  });
});
