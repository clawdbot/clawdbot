// @vitest-environment node
// Browser-local preference persistence: chat, talk, theme, text scale, and the
// local user identity. Split from settings.node.test.ts to keep each file under
// the lint size budget.
import { describe, expect, it, vi } from "vitest";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import {
  expectedGatewayUrl,
  installSettingsStorageLifecycle,
  setTestLocation,
} from "../test-helpers/settings-node.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import {
  applyServerUiPrefs,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import {
  loadLocalUserIdentity,
  patchSettings,
  persistSessionToken,
  loadSettings,
  loadUiPreferences,
  normalizeChatMessageMaxWidth,
  saveSettings,
} from "./settings.ts";

describe("settings preference persistence", () => {
  installSettingsStorageLifecycle();

  it.each([false, true])(
    "keeps the live connection URL when a same-scope spelling was persisted (private storage: %s)",
    (privateStorage) => {
      setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
      if (privateStorage) {
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
          throw new Error("Storage unavailable");
        });
      }
      saveSettings({
        ...loadSettings(),
        gatewayUrl: "wss://gateway.example/control/",
        realtimeTalkInputDeviceId: "scoped-mic",
      });
      expect(loadUiPreferences("wss://gateway.example/control")).toMatchObject({
        gatewayUrl: "wss://gateway.example/control",
        realtimeTalkInputDeviceId: "scoped-mic",
      });
    },
  );

  it("keeps live preferences scoped through cross-tab edits, gateway switches, and credential rotation", async () => {
    setTestLocation({ protocol: "https:", host: "gateway-a.example", pathname: "/" });
    const events = new EventTarget();
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
    const first = {
      ...loadSettings(),
      realtimeTalkInputDeviceId: "mic-a",
      chatSendShortcut: "modifier-enter" as const,
    };
    const second = {
      ...first,
      gatewayUrl: "wss://gateway-b.example",
      realtimeTalkInputDeviceId: "mic-b",
      chatSendShortcut: "enter" as const,
    };
    saveSettings(first);
    saveSettings(second);
    const { gateway } = createGatewayStoreTestStore({ settings: first });
    const theme = createApplicationTheme(first, gateway);
    try {
      resetServerUiPrefsSync();
      const key = `openclaw.control.settings.v1:${first.gatewayUrl}`;
      const next = {
        ...JSON.parse(localStorage.getItem(key) ?? "{}"),
        realtimeTalkInputDeviceId: "cross-tab-mic",
      };
      localStorage.setItem(key, JSON.stringify(next));
      const credentialReads = vi.spyOn(sessionStorage, "getItem");
      events.dispatchEvent(Object.assign(new Event("storage"), { key }));
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("cross-tab-mic");
      expect(credentialReads).not.toHaveBeenCalled();
      expect(theme.settings).not.toHaveProperty("token");

      const selectionKey = `openclaw.control.currentGateway.v1:${first.gatewayUrl}`;
      localStorage.setItem(selectionKey, second.gatewayUrl);
      events.dispatchEvent(Object.assign(new Event("storage"), { key: selectionKey }));
      expect.soft(loadSettings().gatewayUrl).toBe(first.gatewayUrl);
      expect
        .soft(resolveServerUiPrefState({}, "chatSendShortcut", first.gatewayUrl).value)
        .toBe("modifier-enter");
      expect
        .soft(
          applyServerUiPrefs(
            { ui: { prefs: { chatSendShortcut: "enter" } } },
            {
              scope: first.gatewayUrl,
              onApplied: vi.fn(),
            },
          ),
        )
        .toBe(true);
      expect.soft(theme.settings.chatSendShortcut).toBe("enter");
      patchSettings({ chatSendShortcut: "modifier-enter" });
      expect(theme.settings.chatSendShortcut).toBe("modifier-enter");
      patchSettings({ chatSendShortcut: "enter" });
      expect(theme.settings.gatewayUrl).toBe(first.gatewayUrl);
      expect(JSON.parse(localStorage.getItem(key) ?? "{}").realtimeTalkInputDeviceId).toBe(
        "cross-tab-mic",
      );
      gateway.connect({ gatewayUrl: second.gatewayUrl });
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("mic-b");
      gateway.connect({ gatewayUrl: first.gatewayUrl });
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("cross-tab-mic");
      expect(theme.settings.chatSendShortcut).toBe("enter");

      persistSessionToken(first.gatewayUrl, "synthetic-rotated-credential");
      credentialReads.mockClear();
      patchSettings({ composerHoldToRecord: false });
      expect(credentialReads.mock.calls.map(([readKey]) => readKey)).toEqual([
        `openclaw.control.token.v1:${first.gatewayUrl}`,
      ]);
      expect(theme.settings.composerHoldToRecord).toBe(false);
    } finally {
      resetServerUiPrefsSync();
      theme.dispose();
      gateway.stop();
      await vi.dynamicImportSettled();
    }
  });

  it("retains live private-storage edits and releases the mounted preference owner", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
    const initial = loadSettings();
    const { gateway } = createGatewayStoreTestStore({ settings: initial });
    const theme = createApplicationTheme(initial, gateway);
    try {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      patchSettings({ realtimeTalkInputDeviceId: "private-mic" });
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("private-mic");
      const reads = vi.spyOn(sessionStorage, "getItem");
      for (let i = 0; i < 10; i++) {
        expect(theme.settings.realtimeTalkInputDeviceId).toBe("private-mic");
      }
      expect(reads).not.toHaveBeenCalled();
      theme.dispose();
      patchSettings({ realtimeTalkInputDeviceId: "after-dispose" });
      expect(theme.settings.realtimeTalkInputDeviceId).toBe("private-mic");
    } finally {
      theme.dispose();
      gateway.stop();
    }
  });

  it("defaults the chat send shortcut to enter", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    expect(loadSettings().chatSendShortcut).toBe("enter");
  });

  it("persists only the non-default chat send shortcut", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    saveSettings({ ...loadSettings(), chatSendShortcut: "modifier-enter" });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").chatSendShortcut).toBe(
      "modifier-enter",
    );
    expect(loadSettings().chatSendShortcut).toBe("modifier-enter");

    saveSettings({ ...loadSettings(), chatSendShortcut: "enter" });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "chatSendShortcut",
    );

    localStorage.setItem(
      scopedKey,
      JSON.stringify({ gatewayUrl: gwUrl, chatSendShortcut: "unsupported" }),
    );
    expect(loadSettings().chatSendShortcut).toBe("enter");
  });

  it("persists only explicit chat follow-up overrides", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    expect(loadSettings().chatFollowUpMode).toBeUndefined();
    saveSettings({ ...loadSettings(), chatFollowUpMode: "queue" });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").chatFollowUpMode).toBe("queue");
    expect(loadSettings().chatFollowUpMode).toBe("queue");

    saveSettings({ ...loadSettings(), chatFollowUpMode: "steer" });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").chatFollowUpMode).toBe("steer");
    expect(loadSettings().chatFollowUpMode).toBe("steer");

    saveSettings({ ...loadSettings(), chatFollowUpMode: undefined });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "chatFollowUpMode",
    );
    localStorage.setItem(
      scopedKey,
      JSON.stringify({ gatewayUrl: gwUrl, chatFollowUpMode: "interrupt" }),
    );
    expect(loadSettings().chatFollowUpMode).toBeUndefined();
  });

  it("defaults task progress auto-collapse off and persists only the opt-in", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    expect(loadSettings().chatCollapseTaskProgress).toBe(false);

    saveSettings({ ...loadSettings(), chatCollapseTaskProgress: true });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").chatCollapseTaskProgress).toBe(true);
    expect(loadSettings().chatCollapseTaskProgress).toBe(true);

    saveSettings({ ...loadSettings(), chatCollapseTaskProgress: false });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "chatCollapseTaskProgress",
    );

    localStorage.setItem(
      scopedKey,
      JSON.stringify({ gatewayUrl: gwUrl, chatCollapseTaskProgress: "yes" }),
    );
    expect(loadSettings().chatCollapseTaskProgress).toBe(false);
  });

  it("persists only the non-default catalog open target", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    expect(loadSettings().catalogOpenTarget).toBe("viewer");
    saveSettings({ ...loadSettings(), catalogOpenTarget: "terminal" });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").catalogOpenTarget).toBe("terminal");
    expect(loadSettings().catalogOpenTarget).toBe("terminal");

    saveSettings({ ...loadSettings(), catalogOpenTarget: "viewer" });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "catalogOpenTarget",
    );
    localStorage.setItem(
      scopedKey,
      JSON.stringify({ gatewayUrl: gwUrl, catalogOpenTarget: "shell" }),
    );
    expect(loadSettings().catalogOpenTarget).toBe("viewer");
  });

  it("persists pinned agents and drops malformed or duplicate entries", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
      pinnedAgentIds: ["main", "research"],
    });
    expect(loadSettings().pinnedAgentIds).toEqual(["main", "research"]);

    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    const persisted = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<
      string,
      unknown
    >;
    persisted.pinnedAgentIds = ["main", "main", 7, "  ", " research "];
    localStorage.setItem(scopedKey, JSON.stringify(persisted));
    expect(loadSettings().pinnedAgentIds).toEqual(["main", "research"]);
  });

  it("defaults live sidebar activity on and persists only an explicit opt-out", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    expect(loadSettings().sidebarLiveActivity).toBe(true);

    saveSettings({ ...loadSettings(), sidebarLiveActivity: false });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").sidebarLiveActivity).toBe(false);
    expect(loadSettings().sidebarLiveActivity).toBe(false);

    saveSettings({ ...loadSettings(), sidebarLiveActivity: true });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "sidebarLiveActivity",
    );
  });

  it("defaults advanced settings off and persists only an explicit opt-in", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example:8443", pathname: "/" });
    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;

    expect(loadSettings().showAdvancedSettings).toBe(false);
    saveSettings({ ...loadSettings(), showAdvancedSettings: true });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").showAdvancedSettings).toBe(true);
    expect(loadSettings().showAdvancedSettings).toBe(true);

    saveSettings({ ...loadSettings(), showAdvancedSettings: false });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "showAdvancedSettings",
    );
  });

  it("normalizes and persists browser-local chat message width", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example:8443", pathname: "/" });
    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;

    expect(normalizeChatMessageMaxWidth("  min(1280px,   82%)  ")).toBe("min(1280px, 82%)");
    expect(normalizeChatMessageMaxWidth("960px; color: red")).toBeUndefined();

    saveSettings({ ...loadSettings(), chatMessageMaxWidth: "  min(1280px,   82%)  " });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").chatMessageMaxWidth).toBe(
      "min(1280px, 82%)",
    );
    expect(loadSettings().chatMessageMaxWidth).toBe("min(1280px, 82%)");

    saveSettings({ ...loadSettings(), chatMessageMaxWidth: undefined });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "chatMessageMaxWidth",
    );
  });

  it("keeps the last written settings in memory when persistence fails", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    saveSettings({
      ...loadSettings(),
      realtimeTalkInputDeviceId: "usb-mic",
      realtimeTalkVideoDeviceId: "desk-camera",
    });

    // Same-tab reads (e.g. a talk session launched from chat) must observe
    // the selection even though localStorage rejected the write.
    expect(loadSettings().realtimeTalkInputDeviceId).toBe("usb-mic");
    expect(loadSettings().realtimeTalkVideoDeviceId).toBe("desk-camera");

    setItem.mockRestore();
    saveSettings({
      ...loadSettings(),
      realtimeTalkInputDeviceId: undefined,
      realtimeTalkVideoDeviceId: undefined,
    });
    expect(loadSettings().realtimeTalkInputDeviceId).toBeUndefined();
    expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();
  });

  it("persists only a normalized realtime Talk microphone id", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    saveSettings({ ...loadSettings(), realtimeTalkInputDeviceId: " usb-mic " });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").realtimeTalkInputDeviceId).toBe(
      "usb-mic",
    );
    expect(loadSettings().realtimeTalkInputDeviceId).toBe("usb-mic");

    saveSettings({ ...loadSettings(), realtimeTalkInputDeviceId: "" });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "realtimeTalkInputDeviceId",
    );
  });

  it("persists only a normalized realtime Talk camera id", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    saveSettings({ ...loadSettings(), realtimeTalkVideoDeviceId: " back-camera " });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").realtimeTalkVideoDeviceId).toBe(
      "back-camera",
    );
    expect(loadSettings().realtimeTalkVideoDeviceId).toBe("back-camera");

    saveSettings({ ...loadSettings(), realtimeTalkVideoDeviceId: "" });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "realtimeTalkVideoDeviceId",
    );
  });

  it("defaults composer hold-to-record on and persists only the opt-out", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    expect(loadSettings().composerHoldToRecord).toBe(true);

    saveSettings({ ...loadSettings(), composerHoldToRecord: false });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").composerHoldToRecord).toBe(false);
    expect(loadSettings().composerHoldToRecord).toBe(false);

    saveSettings({ ...loadSettings(), composerHoldToRecord: true });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(
      "composerHoldToRecord",
    );
    expect(loadSettings().composerHoldToRecord).toBe(true);
  });

  it("normalizes and persists the device-local talk camera preference", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    expect(loadSettings().talkCameraAutoEnable).toBeUndefined();

    saveSettings({ ...loadSettings(), talkCameraAutoEnable: true });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").talkCameraAutoEnable).toBe(true);
    expect(loadSettings().talkCameraAutoEnable).toBe(true);

    saveSettings({ ...loadSettings(), talkCameraAutoEnable: false });
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}").talkCameraAutoEnable).toBe(false);
    expect(loadSettings().talkCameraAutoEnable).toBe(false);

    localStorage.setItem(
      scopedKey,
      JSON.stringify({ gatewayUrl: gwUrl, talkCameraAutoEnable: "true" }),
    );
    expect(loadSettings().talkCameraAutoEnable).toBeUndefined();
  });

  it("persists themeMode and navWidth alongside the selected theme", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "dash",
      themeMode: "light",
      chatShowThinking: true,
      chatShowToolCalls: true,
      navCollapsed: false,
      navWidth: 320,
      sidebarEntries: [],
    });

    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    const persisted = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(persisted.theme).toBe("dash");
    expect(persisted.themeMode).toBe("light");
    expect(persisted.navWidth).toBe(320);
  });

  it("normalizes persisted text scale to the nearest supported stop", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({
        gatewayUrl: gwUrl,
        textScale: 123,
      }),
    );

    expect(loadSettings().textScale).toBe(125);
  });

  it.each(["fontUi", "fontChat"] as const)(
    "persists only explicit, supported %s overrides",
    (key) => {
      setTestLocation({ protocol: "https:", host: "gateway.example:8443", pathname: "/" });
      const defaults = loadSettings();
      const scopedKey = `openclaw.control.settings.v1:${defaults.gatewayUrl}`;
      expect(defaults[key]).toBeUndefined();

      for (const face of ["geist", "lora", "system"] as const) {
        saveSettings({ ...loadSettings(), [key]: face });
        expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")[key]).toBe(face);
        expect(loadSettings()[key]).toBe(face);
      }
      saveSettings({ ...loadSettings(), [key]: undefined });
      expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(key);
      expect(loadSettings()[key]).toBeUndefined();

      for (const value of ["theme", "unknown-font", "Geist, sans-serif", 42, { family: "lora" }]) {
        localStorage.setItem(
          scopedKey,
          JSON.stringify({ gatewayUrl: defaults.gatewayUrl, [key]: value }),
        );
        expect(loadSettings()[key]).toBeUndefined();
        saveSettings(loadSettings());
        expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty(key);
      }
    },
  );

  it("omits the inherited text scale and removes an authored override on reset", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const defaults = loadSettings();
    const scopedKey = `openclaw.control.settings.v1:${defaults.gatewayUrl}`;
    expect(defaults.textScale).toBeUndefined();

    saveSettings({ ...defaults, textScale: 125 });
    expect(
      JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<string, unknown>,
    ).toMatchObject({ textScale: 125 });

    saveSettings({ ...loadSettings(), textScale: undefined });
    const reset = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<string, unknown>;
    expect(Object.hasOwn(reset, "textScale")).toBe(false);
  });

  it("treats the legacy always-persisted default text scale as inherited", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const gatewayUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gatewayUrl}`;
    localStorage.setItem(scopedKey, JSON.stringify({ gatewayUrl, textScale: 100 }));

    expect(loadSettings().textScale).toBeUndefined();
    saveSettings(loadSettings());
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).not.toHaveProperty("textScale");
  });

  it("persists the browser-local custom theme payload when present", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const customTheme = createImportedCustomThemeFixture();
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "custom",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
      customTheme,
    });

    const settings = loadSettings();
    expect(settings.theme).toBe("custom");
    expect(settings.customTheme?.label).toBe("Light Green");
    expect(settings.customTheme?.themeId).toBe("cmlhfpjhw000004l4f4ax3m7z");
  });

  it("falls back to claw when persisted custom theme data is invalid", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({
        gatewayUrl: gwUrl,
        theme: "custom",
        themeMode: "dark",
        chatShowThinking: true,
        chatShowToolCalls: true,
        navCollapsed: false,
        navWidth: 258,
        sidebarEntries: [],
        customTheme: {
          sourceUrl: "https://tweakcn.com/themes/broken",
          themeId: "broken",
          label: "Broken",
          importedAt: "2026-04-22T00:00:00.000Z",
          light: {},
          dark: {},
        },
        sessionsByGateway: {
          [gwUrl]: {
            sessionKey: "main",
            lastActiveSessionKey: "main",
          },
        },
      }),
    );

    const settings = loadSettings();
    expect(settings.theme).toBe("claw");
    expect(settings.themeMode).toBe("dark");
  });

  it("loads local user identity separately from gateway settings", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    localStorage.setItem(
      "openclaw.control.user.v1",
      JSON.stringify({ name: "Buns", avatar: "🦞" }),
    );

    expect(loadLocalUserIdentity()).toEqual({
      name: "Buns",
      avatar: "🦞",
    });
    expect(JSON.parse(localStorage.getItem("openclaw.control.user.v1") ?? "{}")).toEqual({
      name: "Buns",
      avatar: "🦞",
    });
  });

  it("normalizes invalid local user identity values on load", () => {
    localStorage.setItem(
      "openclaw.control.user.v1",
      JSON.stringify({
        name: "  ",
        avatar: "https://example.com/avatar.png",
      }),
    );

    expect(loadLocalUserIdentity()).toEqual({
      name: null,
      avatar: null,
    });
  });
});
