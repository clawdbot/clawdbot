/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopPanelEmbeddedController } from "./desktop-panel-embedded-controller.ts";

type EmbeddedDesktopPanelHost = ConstructorParameters<typeof DesktopPanelEmbeddedController>[0];

function createHost(overrides: Partial<EmbeddedDesktopPanelHost> = {}) {
  return {
    available: true,
    embedded: true,
    isConnected: true,
    connectRequestedEnvironment: vi.fn(async () => {}),
    refreshEnvironments: vi.fn(async () => true),
    returnToPicker: vi.fn(),
    ...overrides,
  } satisfies EmbeddedDesktopPanelHost;
}

describe("embedded desktop panel controller", () => {
  afterEach(() => vi.useRealTimers());

  it("leaves standalone toggle requests to the dock owner", () => {
    const host = createHost({ embedded: false });
    const controller = new DesktopPanelEmbeddedController(host);

    expect(controller.handleToggle({ open: true })).toBe(false);
    expect(host.refreshEnvironments).not.toHaveBeenCalled();
  });

  it("closes embedded content without writing standalone layout", () => {
    const host = createHost();
    const controller = new DesktopPanelEmbeddedController(host);

    expect(controller.handleToggle({ open: false })).toBe(true);
    expect(host.returnToPicker).toHaveBeenCalledOnce();
    expect(host.refreshEnvironments).not.toHaveBeenCalled();
  });

  it("connects the requested embedded environment", () => {
    const host = createHost();
    const controller = new DesktopPanelEmbeddedController(host);

    expect(controller.handleToggle({ environmentId: "worker-a" })).toBe(true);
    expect(host.connectRequestedEnvironment).toHaveBeenCalledWith("worker-a");
    expect(host.refreshEnvironments).not.toHaveBeenCalled();
  });

  it("coalesces deferred refreshes while the embedded host is available", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const controller = new DesktopPanelEmbeddedController(host);

    controller.scheduleRefresh();
    controller.scheduleRefresh();
    expect(host.refreshEnvironments).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(host.refreshEnvironments).toHaveBeenCalledOnce();
  });

  it("cancels a deferred refresh when availability is lost", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const controller = new DesktopPanelEmbeddedController(host);
    controller.scheduleRefresh();
    Object.assign(host, { available: false });

    controller.handleAvailabilityChange();
    await vi.runAllTimersAsync();

    expect(host.returnToPicker).toHaveBeenCalledOnce();
    expect(host.refreshEnvironments).not.toHaveBeenCalled();
  });
});
