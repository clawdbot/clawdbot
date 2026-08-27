// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { waitForGatewayClient } from "./gateway-readiness.ts";

type Gateway = Parameters<typeof waitForGatewayClient>[0];
type GatewaySnapshot = Gateway["snapshot"];

function createGateway(connected = false) {
  const client = {} as GatewayBrowserClient;
  let snapshot = {
    phase: connected ? "connected" : "connecting",
    client: connected ? client : null,
  } as GatewaySnapshot;
  const listeners = new Set<(next: GatewaySnapshot) => void>();
  const unsubscribe = vi.fn((listener: (next: GatewaySnapshot) => void) => {
    listeners.delete(listener);
  });
  const subscribe = vi.fn((listener: (next: GatewaySnapshot) => void) => {
    listeners.add(listener);
    return () => unsubscribe(listener);
  });
  const gateway: Gateway = {
    get snapshot() {
      return snapshot;
    },
    subscribe,
  };
  return {
    gateway,
    client,
    subscribe,
    unsubscribe,
    connect: () => {
      snapshot = { ...snapshot, phase: "connected", client };
      for (const listener of Array.from(listeners)) {
        listener(snapshot);
      }
    },
  };
}

describe("waitForGatewayClient", () => {
  it("rejects an already-aborted signal before returning a connected client", async () => {
    const { gateway, subscribe } = createGateway(true);
    const cancellation = new Error("navigation canceled");
    const controller = new AbortController();
    controller.abort(cancellation);

    await expect(waitForGatewayClient(gateway, controller.signal)).rejects.toBe(cancellation);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted signal before subscribing to a disconnected gateway", async () => {
    const { gateway, subscribe } = createGateway();
    const controller = new AbortController();
    controller.abort();

    await expect(waitForGatewayClient(gateway, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("keeps the existing AbortError contract for a non-error cancellation reason", async () => {
    const { gateway } = createGateway(true);
    const controller = new AbortController();
    controller.abort("navigation canceled");

    await expect(waitForGatewayClient(gateway, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "Gateway wait aborted",
    });
  });

  it("returns a connected client without subscribing while its signal remains active", async () => {
    const { gateway, client, subscribe } = createGateway(true);

    await expect(waitForGatewayClient(gateway, new AbortController().signal)).resolves.toBe(client);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("removes a pending gateway subscription when its signal is aborted", async () => {
    const { gateway, unsubscribe } = createGateway();
    const cancellation = new Error("navigation canceled");
    const controller = new AbortController();
    const pending = waitForGatewayClient(gateway, controller.signal);

    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("releases a pending subscription once its gateway connects", async () => {
    const { gateway, client, connect, unsubscribe } = createGateway();
    const controller = new AbortController();
    const pending = waitForGatewayClient(gateway, controller.signal);

    connect();

    await expect(pending).resolves.toBe(client);
    expect(unsubscribe).toHaveBeenCalledOnce();
    controller.abort();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not retain an abort listener after synchronous connection replay", async () => {
    const client = {} as GatewayBrowserClient;
    const snapshot = { phase: "connected", client } as GatewaySnapshot;
    const unsubscribe = vi.fn();
    const gateway: Gateway = {
      snapshot: { phase: "connecting", client: null } as GatewaySnapshot,
      subscribe(listener) {
        listener(snapshot);
        return unsubscribe;
      },
    };
    const controller = new AbortController();
    const addAbortListener = vi.spyOn(controller.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");

    await expect(waitForGatewayClient(gateway, controller.signal)).resolves.toBe(client);

    const abortListener = addAbortListener.mock.calls[0]?.[1];
    expect(abortListener).toBeTypeOf("function");
    expect(removeAbortListener).toHaveBeenCalledWith("abort", abortListener);
    expect(unsubscribe).toHaveBeenCalledOnce();

    controller.abort(new Error("late navigation cancellation"));

    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("releases a subscription when it synchronously aborts during registration", async () => {
    const cancellation = new Error("navigation canceled during registration");
    const controller = new AbortController();
    const unsubscribe = vi.fn();
    const gateway: Gateway = {
      snapshot: { phase: "connecting", client: null } as GatewaySnapshot,
      subscribe() {
        controller.abort(cancellation);
        return unsubscribe;
      },
    };

    await expect(waitForGatewayClient(gateway, controller.signal)).rejects.toBe(cancellation);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
