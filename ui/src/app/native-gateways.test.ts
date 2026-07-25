/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeGatewaysCapability,
  type NativeGatewaysCapability,
} from "./native-gateways.ts";

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
  capability?.dispose();
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

  it("updates from events and removes the listener on dispose", () => {
    installBridge();
    capability = createNativeGatewaysCapability();
    const listener = vi.fn();
    capability?.subscribe(listener);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot }));
    expect(capability?.snapshot).toEqual(snapshot);
    expect(listener).toHaveBeenCalledWith(snapshot);
    capability?.dispose();
    capability = null;
    listener.mockClear();
    window.dispatchEvent(
      new CustomEvent(EVENT, { detail: { ...snapshot, currentId: "profile:studio" } }),
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
