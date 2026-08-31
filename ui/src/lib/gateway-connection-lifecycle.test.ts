// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";

describe("gateway connection lifecycle", () => {
  it("captures connected clients and preserves scopes across unchanged snapshots", () => {
    const client = {} as GatewayBrowserClient;
    const lifecycle = createGatewayConnectionLifecycle({ client, phase: "connected" });
    const scope = lifecycle.capture();

    expect(scope).toEqual({ client, epoch: 0 });
    expect(lifecycle.transition({ client, phase: "connected" })).toBe(false);
    expect(scope && lifecycle.isCurrent(scope)).toBe(true);
  });

  it.each(["connecting", "reconnecting", "offline", "stopped"] as const)(
    "does not capture a %s connection",
    (phase) => {
      const lifecycle = createGatewayConnectionLifecycle({
        client: {} as GatewayBrowserClient,
        phase,
      });

      expect(lifecycle.capture()).toBeNull();
    },
  );

  it("retires old requests across a reconnect that reuses the same client", () => {
    const client = {} as GatewayBrowserClient;
    const lifecycle = createGatewayConnectionLifecycle({ client, phase: "connected" });
    const first = lifecycle.capture();

    expect(first).not.toBeNull();
    expect(lifecycle.transition({ client, phase: "reconnecting" })).toBe(true);
    expect(first && lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.capture()).toBeNull();
    expect(lifecycle.transition({ client, phase: "connected" })).toBe(true);

    const second = lifecycle.capture();
    expect(second).toEqual({ client, epoch: 2 });
    expect(first && lifecycle.isCurrent(first)).toBe(false);
    expect(second && lifecycle.isCurrent(second)).toBe(true);
  });

  it("retires old requests when the connected gateway client is replaced", () => {
    const previous = {} as GatewayBrowserClient;
    const replacement = {} as GatewayBrowserClient;
    const lifecycle = createGatewayConnectionLifecycle({
      client: previous,
      phase: "connected",
    });
    const stale = lifecycle.capture();

    expect(lifecycle.transition({ client: replacement, phase: "connected" })).toBe(true);
    expect(stale && lifecycle.isCurrent(stale)).toBe(false);
    expect(lifecycle.capture()).toEqual({ client: replacement, epoch: 1 });
  });

  it("retires a connection scope without changing its client or connection phase", () => {
    const client = {} as GatewayBrowserClient;
    const lifecycle = createGatewayConnectionLifecycle({ client, phase: "connected" });
    const stale = lifecycle.capture();

    lifecycle.invalidate();

    expect(lifecycle.epoch).toBe(1);
    expect(stale && lifecycle.isCurrent(stale)).toBe(false);
    expect(lifecycle.capture()).toEqual({ client, epoch: 1 });
  });

  it("retires all scopes when disposed and cannot be reactivated", () => {
    const client = {} as GatewayBrowserClient;
    const lifecycle = createGatewayConnectionLifecycle({ client, phase: "connected" });
    const stale = lifecycle.capture();

    lifecycle.dispose();
    lifecycle.dispose();
    lifecycle.invalidate();

    expect(lifecycle.epoch).toBe(1);
    expect(stale && lifecycle.isCurrent(stale)).toBe(false);
    expect(lifecycle.capture()).toBeNull();
    expect(lifecycle.transition({ client, phase: "connected" })).toBe(false);
  });
});
