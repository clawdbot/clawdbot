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

    expect(capability?.snapshot).toEqual({ permission: "unknown", test: null });
    expect(postMessage).toHaveBeenCalledWith({ type: "status" });
  });

  it("accepts the permission-only native snapshot", () => {
    installBridge();
    (window as NativeNotificationsTestWindow)["__OPENCLAW_NATIVE_NOTIFICATIONS__"] = {
      permission: "granted",
    };

    capability = createNativeNotificationsCapability();

    expect(capability?.snapshot).toEqual({ permission: "granted", test: null });
  });

  it("publishes valid status events", () => {
    installBridge();
    capability = createNativeNotificationsCapability();
    const listener = vi.fn();
    capability?.subscribe(listener);

    window.dispatchEvent(
      new CustomEvent(NATIVE_NOTIFICATIONS_STATUS_EVENT, {
        detail: { permission: "denied", test: null },
      }),
    );

    expect(capability?.snapshot).toEqual({ permission: "denied", test: null });
    expect(listener).toHaveBeenCalledWith({ permission: "denied", test: null });
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

    expect(capability?.snapshot).toEqual({ permission: "unknown", test: null });
    expect(listener).not.toHaveBeenCalled();
  });

  it("reposts status when the window focuses", () => {
    const postMessage = installBridge();
    capability = createNativeNotificationsCapability();
    postMessage.mockClear();

    window.dispatchEvent(new Event("focus"));

    expect(postMessage).toHaveBeenCalledWith({ type: "status" });
  });

  it("posts permission requests", () => {
    const postMessage = installBridge();
    capability = createNativeNotificationsCapability();
    postMessage.mockClear();

    capability?.requestPermission();

    expect(postMessage).toHaveBeenCalledWith({ type: "request-permission" });
  });

  it("publishes pending immediately and suppresses duplicate test sends", () => {
    const postMessage = installBridge();
    capability = createNativeNotificationsCapability();
    postMessage.mockClear();

    capability?.sendTest();
    capability?.sendTest();

    expect(capability?.snapshot).toEqual({ permission: "unknown", test: { state: "pending" } });
    expect(postMessage.mock.calls).toEqual([[{ type: "send-test" }]]);
  });

  it.each(["unknown", "notDetermined", "denied", "granted"] as const)(
    "sends private background completion only with granted permission: %s",
    (permission) => {
      const postMessage = installBridge();
      capability = createNativeNotificationsCapability();
      if (permission !== "unknown") {
        window.dispatchEvent(
          new CustomEvent(NATIVE_NOTIFICATIONS_STATUS_EVENT, {
            detail: { permission, test: null },
          }),
        );
      }
      postMessage.mockClear();

      capability?.backgroundSessionCompleted({ runId: "run-1", path: "/chat/research" });

      expect(postMessage.mock.calls).toEqual(
        permission === "granted"
          ? [[{ type: "background-session-completed", runId: "run-1", path: "/chat/research" }]]
          : [],
      );
    },
  );

  it("keeps permission and failed send as independent facts across focus refresh", () => {
    const postMessage = installBridge();
    capability = createNativeNotificationsCapability();

    window.dispatchEvent(
      new CustomEvent(NATIVE_NOTIFICATIONS_STATUS_EVENT, {
        detail: {
          permission: "granted",
          test: { state: "error", message: "Open System Settings and try again." },
        },
      }),
    );
    postMessage.mockClear();
    window.dispatchEvent(new Event("focus"));

    expect(capability?.snapshot).toEqual({
      permission: "granted",
      test: { state: "error", message: "Open System Settings and try again." },
    });
    expect(postMessage).toHaveBeenCalledWith({ type: "status" });
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
        detail: { permission: "granted", test: null },
      }),
    );

    expect(postMessage).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
