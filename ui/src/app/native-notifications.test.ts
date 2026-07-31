/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeNotificationsCapability,
  type NativeNotificationsCapability,
} from "./native-notifications.ts";

// Wire contract shared with the Mac app bridge; asserted literally on purpose.
const NATIVE_NOTIFICATIONS_STATUS_EVENT = "openclaw:native-notifications-status";

type NativeNotificationsMessage = {
  type: "status" | "request-permission" | "send-test";
};

type NativeNotificationsTestWindow = Window & {
  __OPENCLAW_NATIVE_NOTIFICATIONS__?: unknown;
};

let capability: NativeNotificationsCapability | null = null;

afterEach(() => {
  capability?.dispose();
  capability = null;
  Reflect.deleteProperty(
    window as NativeNotificationsTestWindow,
    "__OPENCLAW_NATIVE_NOTIFICATIONS__",
  );
  vi.unstubAllGlobals();
});

function installBridge() {
  const postMessage = vi.fn<(message: NativeNotificationsMessage) => void>();
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawNotifications: { postMessage } },
  });
  return postMessage;
}

describe("native notifications", () => {
  it("returns null without the WebKit bridge", () => {
    expect(createNativeNotificationsCapability()).toBeNull();
  });

  it("posts status on create", () => {
    const postMessage = installBridge();

    capability = createNativeNotificationsCapability();

    expect(capability?.snapshot).toEqual({ permission: "unknown" });
    expect(postMessage).toHaveBeenCalledWith({ type: "status" });
  });

  it("seeds status from the native snapshot", () => {
    installBridge();
    (window as NativeNotificationsTestWindow)["__OPENCLAW_NATIVE_NOTIFICATIONS__"] = {
      permission: "granted",
    };

    capability = createNativeNotificationsCapability();

    expect(capability?.snapshot).toEqual({ permission: "granted" });
  });

  it("publishes valid status events", () => {
    installBridge();
    capability = createNativeNotificationsCapability();
    const listener = vi.fn();
    capability?.subscribe(listener);

    window.dispatchEvent(
      new CustomEvent(NATIVE_NOTIFICATIONS_STATUS_EVENT, {
        detail: { permission: "denied" },
      }),
    );

    expect(capability?.snapshot).toEqual({ permission: "denied" });
    expect(listener).toHaveBeenCalledWith({ permission: "denied" });
  });

  it("ignores invalid status event details", () => {
    installBridge();
    capability = createNativeNotificationsCapability();
    const listener = vi.fn();
    capability?.subscribe(listener);

    window.dispatchEvent(
      new CustomEvent(NATIVE_NOTIFICATIONS_STATUS_EVENT, {
        detail: { permission: "authorized" },
      }),
    );

    expect(capability?.snapshot).toEqual({ permission: "unknown" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("reposts status when the window focuses", () => {
    const postMessage = installBridge();
    capability = createNativeNotificationsCapability();
    postMessage.mockClear();

    window.dispatchEvent(new Event("focus"));

    expect(postMessage).toHaveBeenCalledWith({ type: "status" });
  });

  it("posts permission and test actions", () => {
    const postMessage = installBridge();
    capability = createNativeNotificationsCapability();
    postMessage.mockClear();

    capability?.requestPermission();
    capability?.sendTest();

    expect(postMessage.mock.calls).toEqual([
      [{ type: "request-permission" }],
      [{ type: "send-test" }],
    ]);
  });

  it("removes listeners on dispose", () => {
    const postMessage = installBridge();
    capability = createNativeNotificationsCapability();
    const listener = vi.fn();
    capability?.subscribe(listener);
    capability?.dispose();
    capability = null;
    postMessage.mockClear();

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(
      new CustomEvent(NATIVE_NOTIFICATIONS_STATUS_EVENT, {
        detail: { permission: "granted" },
      }),
    );

    expect(postMessage).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
