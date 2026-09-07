/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EVENT = "openclaw:native-gateways-changed";
const snapshot = {
  gateways: [
    {
      id: "primary",
      name: "Local Gateway",
      kind: "local" as const,
      isPrimary: true,
      canPromote: false,
      health: "ok" as const,
    },
    {
      id: "profile:studio",
      name: "Studio",
      kind: "remote" as const,
      isPrimary: false,
      canPromote: true,
      health: "unknown" as const,
    },
  ],
  currentId: "primary",
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_GATEWAYS__");
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "webkit");
});

function installBridge() {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawGateways: { postMessage } } });
  return postMessage;
}

describe("native gateways", () => {
  it("returns null without the WebKit bridge", async () => {
    const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");

    expect(nativeGatewaysCapability()).toBeNull();
  });

  it("initializes from the native global and posts actions", async () => {
    const postMessage = installBridge();
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
    const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");
    const capability = nativeGatewaysCapability();

    expect(capability?.snapshot).toEqual(snapshot);
    capability?.select("profile:studio");
    capability?.openWindow("profile:studio");
    capability?.setPrimary("profile:studio");
    capability?.openSettings();
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "select", id: "profile:studio" },
      { type: "open-window", id: "profile:studio" },
      { type: "set-primary", id: "profile:studio" },
      { type: "open-settings" },
    ]);
  });

  it("updates from events and stops notifying after unsubscribe", async () => {
    installBridge();
    const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");
    const capability = nativeGatewaysCapability();
    const listener = vi.fn();
    const unsubscribe = capability?.subscribe(listener);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot }));
    expect(capability?.snapshot).toEqual(snapshot);
    expect(listener).toHaveBeenCalledWith(snapshot);
    unsubscribe?.();
    listener.mockClear();
    window.dispatchEvent(
      new CustomEvent(EVENT, { detail: { ...snapshot, currentId: "profile:studio" } }),
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it("reads the latest global when attached lazily, then publishes native updates", async () => {
    installBridge();
    const attachedSnapshot = { ...snapshot, currentId: "profile:studio" };
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: attachedSnapshot });
    const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");
    const capability = nativeGatewaysCapability();

    expect(capability?.snapshot).toEqual(attachedSnapshot);

    const listener = vi.fn();
    const unsubscribe = capability?.subscribe(listener);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot }));
    expect(listener).toHaveBeenCalledWith(snapshot);
    unsubscribe?.();
  });

  it("creates the app-lifetime singleton only once", async () => {
    installBridge();
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
    const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");

    const first = nativeGatewaysCapability();
    const second = nativeGatewaysCapability();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });
});
