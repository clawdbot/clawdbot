/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeGatewaysCapability,
  nativeGatewaysCapability,
  type NativeGatewaysCapability,
} from "./native-gateways.runtime.ts";

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
let capability: NativeGatewaysCapability | null = null;

afterEach(() => {
  capability = null;
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_GATEWAYS__");
  vi.unstubAllGlobals();
});

function installBridge() {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawGateways: { postMessage } } });
  return postMessage;
}

describe("native gateways", () => {
  it("returns null without the WebKit bridge", () => {
    expect(createNativeGatewaysCapability()).toBeNull();
  });

  it("initializes from the native global and posts actions", () => {
    const postMessage = installBridge();
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
    capability = createNativeGatewaysCapability();
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

  it("updates from events and stops notifying after unsubscribe", () => {
    installBridge();
    capability = createNativeGatewaysCapability();
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

  it("reads the latest global when attached lazily, then publishes native updates", () => {
    installBridge();
    const attachedSnapshot = { ...snapshot, currentId: "profile:studio" };
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: attachedSnapshot });
    capability = createNativeGatewaysCapability();
    expect(capability?.snapshot).toEqual(attachedSnapshot);

    const listener = vi.fn();
    capability?.subscribe(listener);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot }));
    expect(listener).toHaveBeenCalledWith(snapshot);
  });

  it("creates the app-lifetime singleton only once", () => {
    installBridge();
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });

    const first = nativeGatewaysCapability();
    const second = nativeGatewaysCapability();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });
});
