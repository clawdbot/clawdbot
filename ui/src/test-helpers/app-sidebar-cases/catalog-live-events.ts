import { describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  deferred,
  mountSidebar,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session catalog pagination", () => {
  it("coalesces the visibility and focus events from one tab activation", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    try {
      const request = vi.fn().mockResolvedValue(catalogPage([]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(49);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stays paused when an in-flight catalog refresh finishes in a hidden tab", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    try {
      const pending = deferred<SessionsCatalogListResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(catalogPage([]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      pending.resolve(catalogPage([]));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(1);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(49);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stays paused through a Gateway reconnect while the tab is hidden", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    try {
      const foregroundRequest = deferred<SessionsCatalogListResult>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(catalogPage([]))
        .mockReturnValue(foregroundRequest.promise);
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      gateway.publish({
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      gateway.publish({ connected: false, reconnecting: true, hello: null });
      await sidebar.updateComplete;
      gateway.publish({
        connected: true,
        reconnecting: false,
        hello: {
          features: { methods: ["sessions.catalog.list"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(1);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(50);
      expect(request).toHaveBeenCalledTimes(2);
      foregroundRequest.resolve(catalogPage([]));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not poll an older Gateway that does not advertise session catalogs", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue(catalogPage([]));
      const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      globalThis.dispatchEvent(new Event("focus"));
      gateway.publishEvent("presence", {
        presence: [{ deviceId: "node-1", mode: "node", reason: "connect" }],
      });
      gateway.publishEvent("presence", {
        presence: [{ deviceId: "node-1", mode: "node", reason: "disconnect" }],
      });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
