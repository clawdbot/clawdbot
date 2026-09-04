/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeDeviceSettingsSnapshot } from "../test-helpers/native-device-settings.ts";
import {
  createNativeDeviceSettingsCapability,
  type NativeDeviceSettingsCapability,
} from "./native-device-settings.ts";

let capability: NativeDeviceSettingsCapability | null;
afterEach(() => {
  capability?.dispose();
  capability = null;
  vi.unstubAllGlobals();
});

function installBridge(snapshot: unknown = createNativeDeviceSettingsSnapshot()) {
  const post = vi.fn<(message: unknown) => void>();
  vi.stubGlobal("webkit", { messageHandlers: { openclawDeviceSettings: { postMessage: post } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  capability = createNativeDeviceSettingsCapability();
  return post;
}
function publish(detail: unknown) {
  window.dispatchEvent(new CustomEvent("openclaw:native-device-settings-changed", { detail }));
}

describe("native device settings wire contract", () => {
  it("exists only with the native message handler and reads the document-start snapshot", () => {
    vi.stubGlobal("webkit", undefined);
    expect(createNativeDeviceSettingsCapability()).toBeNull();
    const post = installBridge();
    expect(capability?.snapshot).toEqual(createNativeDeviceSettingsSnapshot());
    expect(post.mock.calls).toEqual([[{ type: "status" }]]);
  });

  it.each([
    ["contract", { contract: 2 }],
    ["device", { device: { platform: "macos" } }],
    ["app", { app: { ...createNativeDeviceSettingsSnapshot().app, showDockIcon: "yes" } }],
    [
      "capabilities",
      {
        capabilities: {
          ...createNativeDeviceSettingsSnapshot().capabilities,
          computerControlProvider: "other",
        },
      },
    ],
    [
      "browser",
      {
        browser: {
          importAvailable: true,
          cookieSync: { ...createNativeDeviceSettingsSnapshot().browser.cookieSync, domains: [42] },
        },
      },
    ],
    [
      "permissions",
      { permissions: { ...createNativeDeviceSettingsSnapshot().permissions, entries: [] } },
    ],
    [
      "permission order",
      {
        permissions: {
          ...createNativeDeviceSettingsSnapshot().permissions,
          entries: createNativeDeviceSettingsSnapshot().permissions.entries.toReversed(),
        },
      },
    ],
    [
      "location",
      {
        permissions: {
          ...createNativeDeviceSettingsSnapshot().permissions,
          location: { mode: ["off"], precise: false },
        },
      },
    ],
    [
      "voice",
      {
        voice: {
          ...createNativeDeviceSettingsSnapshot().voice,
          microphone: { selectedId: null, devices: [{ id: "mic" }] },
        },
      },
    ],
    ["updates", { updates: { available: true, automatic: true } }],
  ])("ignores malformed %s snapshots without notifying subscribers", (_name, change) => {
    installBridge();
    const listener = vi.fn();
    capability?.subscribe(listener);
    publish({ ...createNativeDeviceSettingsSnapshot(), ...change });
    expect(capability?.snapshot).toEqual(createNativeDeviceSettingsSnapshot());
    expect(listener).not.toHaveBeenCalled();
  });

  it("waits for a valid snapshot and stops notifications after unsubscribe/dispose", () => {
    const post = installBridge(null);
    expect(capability?.snapshot).toBeNull();
    const listener = vi.fn();
    const unsubscribe = capability?.subscribe(listener);
    const next = createNativeDeviceSettingsSnapshot();
    next.app.showDockIcon = false;
    publish(next);
    expect(capability?.snapshot?.app.showDockIcon).toBe(false);
    expect(listener).toHaveBeenCalledWith(next);
    unsubscribe?.();
    publish(createNativeDeviceSettingsSnapshot());
    expect(listener).toHaveBeenCalledTimes(1);
    post.mockClear();
    window.dispatchEvent(new Event("focus"));
    capability?.refresh();
    expect(post.mock.calls).toEqual([[{ type: "status" }], [{ type: "status" }]]);
    capability?.dispose();
    post.mockClear();
    window.dispatchEvent(new Event("focus"));
    publish(next);
    expect(post).not.toHaveBeenCalled();
    expect(capability?.snapshot?.app.showDockIcon).toBe(true);
  });

  it("posts exact native commands without optimistically changing the owner snapshot", () => {
    const post = installBridge();
    post.mockClear();
    capability?.set("app.showDockIcon", false);
    capability?.set("voice.microphone", null);
    capability?.set("browser.cookieSync.domains", ["example.com"]);
    capability?.set("voice.locale.primary", "de-DE");
    capability?.requestPermission("microphone");
    capability?.openSystemSettings("accessibility");
    capability?.openPanel("quick-chat-shortcut");
    capability?.checkForUpdates();
    expect(post.mock.calls.map(([message]) => message)).toEqual([
      { type: "set", key: "app.showDockIcon", value: false },
      { type: "set", key: "voice.microphone", value: null },
      { type: "set", key: "browser.cookieSync.domains", value: ["example.com"] },
      { type: "set", key: "voice.locale.primary", value: "de-DE" },
      { type: "request-permission", id: "microphone" },
      { type: "open-system-settings", id: "accessibility" },
      { type: "open", panel: "quick-chat-shortcut" },
      { type: "check-for-updates" },
    ]);
    expect(capability?.snapshot?.app.showDockIcon).toBe(true);
  });
});
