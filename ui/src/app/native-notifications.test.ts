/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderNotificationsSection } from "../pages/config/notifications-section.ts";
import type {
  NativeNotificationsMessage,
  NativeNotificationsStatus,
} from "../test-helpers/native-notifications.ts";
import type { ApplicationGateway } from "./gateway.ts";
import {
  createNativeNotificationsCapability,
  type NativeNotificationsCapability,
} from "./native-notifications.ts";
import { createNotificationsCapability } from "./notifications.ts";

const STATUS_EVENT = "openclaw:native-notifications-status";
let capability: NativeNotificationsCapability | null = null;

afterEach(() => {
  capability?.dispose();
  capability = null;
  vi.unstubAllGlobals();
});

function installBridge() {
  const postMessage = vi.fn<(message: NativeNotificationsMessage) => void>();
  vi.stubGlobal("webkit", { messageHandlers: { openclawNotifications: { postMessage } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_NOTIFICATIONS__", {
    supported: true,
    permission: "granted",
  });
  return postMessage;
}

async function loadCapability() {
  capability = createNativeNotificationsCapability();
  await vi.dynamicImportSettled();
}

function emitStatus(status: Partial<NativeNotificationsStatus> = {}) {
  window.dispatchEvent(
    new CustomEvent(STATUS_EVENT, {
      detail: { supported: true, permission: "granted", ...status },
    }),
  );
}

describe("native notifications", () => {
  it("returns null without a native poster", () => {
    expect(createNativeNotificationsCapability()).toBeNull();
  });

  it("retains native status received while its runtime loads", async () => {
    installBridge();
    capability = createNativeNotificationsCapability();
    emitStatus({ permission: "denied" });
    await vi.dynamicImportSettled();
    expect(capability?.snapshot).toMatchObject({ permission: "denied", loading: false });
  });

  it.each(["before load", "initial publication"] as const)(
    "retires a loading native owner on disposal (%s)",
    async (when) => {
      const postMessage = installBridge();
      capability = createNativeNotificationsCapability();
      const retire = vi.fn(() => capability?.dispose());
      if (when === "before load") {
        capability?.dispose();
      } else {
        capability?.subscribe(retire);
      }
      await vi.dynamicImportSettled();
      emitStatus();
      expect(postMessage).not.toHaveBeenCalled();
      expect(retire).toHaveBeenCalledTimes(when === "before load" ? 0 : 1);
    },
  );

  it.each([
    ["__OPENCLAW_NATIVE_WEB_CHROME__", true],
    ["__TAURI__", {}],
    ["__OPENCLAW_NATIVE_CONTROL_AUTH__", {}],
  ])(
    "keeps an older native host unavailable without registering browser push (%s)",
    (marker, value) => {
      vi.stubGlobal(marker, value);
      vi.stubGlobal("navigator", {
        userAgent: "Desktop",
        platform: "MacIntel",
        maxTouchPoints: 0,
        serviceWorker: {},
      });
      vi.stubGlobal("Notification", { permission: "granted" });
      vi.stubGlobal("PushManager", vi.fn());
      const gateway = {
        snapshot: { phase: "stopped", client: null },
        subscribe: () => () => {},
        subscribeEvents: () => () => {},
      } as unknown as ApplicationGateway;
      const selected = createNotificationsCapability(gateway);
      try {
        expect(selected.snapshot).toMatchObject({ kind: "native", supported: false });
        const container = document.createElement("div");
        render(
          renderNotificationsSection({ connected: true, notifications: selected.snapshot }),
          container,
        );
        expect(container.textContent).toContain("Update the OpenClaw app and Gateway");
        expect(container.querySelector("button")).toBeNull();
      } finally {
        selected.dispose();
      }
    },
  );

  it("refreshes status on focus with unique bounded request IDs without asking permission", async () => {
    const postMessage = installBridge();
    await loadCapability();
    window.dispatchEvent(new Event("focus"));

    const requests = postMessage.mock.calls.map(([request]) => request);
    expect(requests.map(({ type }) => type)).toEqual(["status", "status"]);
    expect(new Set(requests.map(({ requestId }) => requestId)).size).toBe(2);
    expect(requests.every(({ requestId }) => requestId.length > 0 && requestId.length <= 64)).toBe(
      true,
    );
  });

  it("settles permission only on its matching response, not a focus refresh or unsolicited event", async () => {
    const postMessage = installBridge();
    await loadCapability();
    const completed = vi.fn();
    const request = capability!.run({ kind: "enable" }).then(completed);
    const action = postMessage.mock.calls.at(-1)![0];
    expect(action.type).toBe("request-permission");
    expect(capability?.snapshot.loading).toBe(true);

    window.dispatchEvent(new Event("focus"));
    emitStatus({ permission: "denied" });
    emitStatus({ replyTo: postMessage.mock.calls.at(-1)![0].requestId });
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(capability?.snapshot.loading).toBe(true);

    emitStatus({ replyTo: action.requestId });
    await request;
    expect(completed).toHaveBeenCalledOnce();
    expect(capability?.snapshot).toMatchObject({ permission: "granted", loading: false });
  });

  it("suppresses duplicate test requests and preserves permission when delivery fails", async () => {
    const postMessage = installBridge();
    await loadCapability();
    postMessage.mockClear();
    const first = capability!.run({ kind: "test" });
    expect(capability!.run({ kind: "test" })).toBe(first);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(capability?.snapshot.test).toEqual({ state: "pending" });

    emitStatus({
      replyTo: expectDefined(postMessage.mock.calls[0], "native test request")[0].requestId,
      test: { state: "error", message: "Notification delivery is unavailable." },
    });
    await first;
    expect(capability?.snapshot).toMatchObject({ permission: "granted", loading: false });
    expect(capability?.snapshot.test).toEqual({
      state: "error",
      message: "Notification delivery is unavailable.",
    });
  });

  it.each(["granted", "denied"] as const)(
    "only restores muted device preferences after granted permission (%s)",
    async (permission) => {
      const postMessage = installBridge();
      await loadCapability();
      postMessage.mockClear();
      const user = {
        categories: {
          approvalRequested: true,
          agentFinished: false,
          agentQuestion: false,
          scheduledTaskFailed: false,
          backgroundTaskFailed: false,
        },
        detailLevel: "private" as const,
        quietHours: { enabled: false, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
        agentIds: [],
      };
      const preferences = {
        user,
        device: {
          enabled: false,
          label: "Desktop",
          detailLevel: "identified" as const,
          agentIds: ["work"],
        },
        effective: { ...user, enabled: false, label: "Desktop" },
        canManageUserPreferences: true,
        devicePersistence: "profile" as const,
      };
      const completed = vi.fn();
      const enabled = capability!.run({ kind: "enable" }).then(completed);
      const permissionRequest = expectDefined(
        postMessage.mock.calls[0],
        "native permission request",
      )[0];
      emitStatus({ permission, preferences, replyTo: permissionRequest.requestId });

      if (permission === "denied") {
        await enabled;
        expect(postMessage).toHaveBeenCalledOnce();
        expect(capability?.snapshot.preferences?.device.enabled).toBe(false);
        expect(capability?.snapshot.loading).toBe(false);
        return;
      }

      expect(postMessage).toHaveBeenCalledTimes(2);
      const save = expectDefined(postMessage.mock.calls[1], "native device preference save")[0];
      expect(save).toMatchObject({
        type: "preferences-set",
        scope: "device",
        preferences: { ...preferences.device, enabled: true },
      });
      expect(save.requestId).not.toBe(permissionRequest.requestId);
      emitStatus({ preferences, replyTo: permissionRequest.requestId });
      await Promise.resolve();
      expect(completed).not.toHaveBeenCalled();
      expect(capability?.snapshot.loading).toBe(true);

      emitStatus({
        preferences: { ...preferences, device: { ...preferences.device, enabled: true } },
        replyTo: save.requestId,
      });
      await enabled;
      expect(capability?.snapshot.loading).toBe(false);
    },
  );

  it("reports an incompatible bridge instead of silently leaving old native controls active", async () => {
    installBridge();
    await loadCapability();
    window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: { permission: "granted" } }));

    expect(capability?.snapshot).toMatchObject({ supported: false, permission: "granted" });
    expect(capability?.snapshot.error).toContain("Update the OpenClaw app and Gateway");
  });

  it("settles failed posts visibly without leaving the test pending", async () => {
    const postMessage = installBridge();
    await loadCapability();
    postMessage.mockImplementation(() => {
      throw new Error("Native bridge closed");
    });

    await capability!.run({ kind: "test" });

    expect(capability?.snapshot).toMatchObject({
      loading: false,
      permission: "granted",
      error: "Native bridge closed",
      test: { state: "error", message: "Native bridge closed" },
    });
  });

  it("retires pending actions and stops events and retained calls on disposal", async () => {
    const postMessage = installBridge();
    await loadCapability();
    const listener = vi.fn();
    capability!.subscribe(listener);
    const pending = capability!.run({ kind: "test" });
    capability!.dispose();
    postMessage.mockClear();
    listener.mockClear();

    window.dispatchEvent(new Event("focus"));
    emitStatus();
    await capability!.run({ kind: "enable" });
    await pending;
    expect(postMessage).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
