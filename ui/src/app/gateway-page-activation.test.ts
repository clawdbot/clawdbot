/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { startGatewayPageActivation } from "./gateway-page-activation.ts";
import { refreshControlUiServiceWorker } from "./sw-refresh.runtime.ts";

vi.mock("./sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));

afterEach(() => {
  vi.mocked(refreshControlUiServiceWorker).mockClear();
  vi.restoreAllMocks();
});

describe("Gateway page activation", () => {
  it("coalesces foreground signals into one stale-client recovery", async () => {
    const connect = vi.fn();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    const dispose = startGatewayPageActivation(
      { snapshot: { client: { needsWakeReconnect: true } }, connect },
      document,
      window,
    );

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();

    expect(connect).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    dispose();
  });

  it("keeps a healthy client mounted when the browser reports online", async () => {
    const connect = vi.fn();
    const dispose = startGatewayPageActivation(
      { snapshot: { client: { needsWakeReconnect: false } }, connect },
      document,
      window,
    );

    window.dispatchEvent(new Event("online"));
    await Promise.resolve();

    expect(connect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    dispose();
  });

  it("ignores initial pageshow and removes every listener on dispose", async () => {
    const connect = vi.fn();
    const dispose = startGatewayPageActivation(
      { snapshot: { client: { needsWakeReconnect: true } }, connect },
      document,
      window,
    );

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();

    dispose();
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(new Event("online"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(connect).not.toHaveBeenCalled();
    expect(refreshControlUiServiceWorker).not.toHaveBeenCalled();
  });
});
