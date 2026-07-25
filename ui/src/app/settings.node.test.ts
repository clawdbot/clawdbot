// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadLocalUserIdentity,
  loadSettings,
  normalizeChatMessageMaxWidth,
  persistSessionToken,
  resolvePageGatewaySettings,
  saveSettings,
  type UiSettings,
} from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";

function setTestLocation(params: { protocol: string; host: string; pathname: string }) {
  vi.stubGlobal("location", {
    protocol: params.protocol,
    host: params.host,
    hostname: params.host.replace(/:\d+$/, ""),
    pathname: params.pathname,
  } as Location);
}

function setControlUiBasePath(value: string | undefined) {
  type TestWindow = Window & typeof globalThis & { [key: string]: unknown };
  if (typeof window === "undefined") {
    vi.stubGlobal(
      "window",
      value == null
        ? ({} as TestWindow)
        : ({ __OPENCLAW_CONTROL_UI_BASE_PATH__: value } as unknown as TestWindow),
    );
    return;
  }
  if (value == null) {
    delete (window as TestWindow)["__OPENCLAW_CONTROL_UI_BASE_PATH__"];
    return;
  }
  Object.defineProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__", {
    value,
    writable: true,
    configurable: true,
  });
}

function expectedGatewayUrl(basePath: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${basePath}`;
}

function makeSettings(gatewayUrl: string, overrides: Partial<UiSettings> = {}): UiSettings {
  return {
    gatewayUrl,
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatShowThinking: true,
    chatShowToolCalls: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 258,
    sidebarEntries: [],
    ...overrides,
  };
}

describe("resolveApplicationStartupSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips fragment bootstrap tokens without persisting them", () => {
    const startup = resolveApplicationStartupSettings(makeSettings("wss://gateway.example"), {
      pathname: "/",
      search: "",
      hash: "#gatewayUrl=wss%3A%2F%2Fgateway.example&bootstrapToken=boot-123&session=main",
    });

    expect(startup.pendingGatewayUrl).toBeNull();
    expect(startup.pendingGatewayToken).toBeNull();
    expect(startup.pendingBootstrapToken).toBe("boot-123");
    expect(startup.settings.token).toBe("");
    expect(startup.location).toEqual({ pathname: "/", search: "", hash: "#session=main" });
  });

  it("carries fragment bootstrap tokens with changed gateway URLs", () => {
    const startup = resolveApplicationStartupSettings(makeSettings("wss://gateway-a.example"), {
      pathname: "/dash",
      search: "",
      hash: "#gatewayUrl=wss%3A%2F%2Fgateway-b.example&bootstrapToken=boot-456",
    });

    expect(startup.pendingGatewayUrl).toBe("wss://gateway-b.example");
    expect(startup.pendingGatewayToken).toBeNull();
    expect(startup.pendingBootstrapToken).toBe("boot-456");
    expect(startup.location).toEqual({ pathname: "/dash", search: "", hash: "" });
  });
});

describe("loadSettings default gateway URL derivation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.clear();
    sessionStorage.clear();
    setControlUiBasePath(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
    saveSettings(loadSettings());
    setControlUiBasePath(undefined);
    vi.unstubAllGlobals();
  });

  it("uses configured base path and normalizes trailing slash", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/ignored/path",
    });
    setControlUiBasePath(" /openclaw/ ");

    expect(loadSettings().gatewayUrl).toBe(expectedGatewayUrl("/openclaw"));
  });

  it("binds standalone documents to the page Gateway without persisting a selection", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/openclaw/approve/exec%3A1",
    });
    setControlUiBasePath("/openclaw");
    const remote = makeSettings("wss://remote.example:8443", {
      sessionKey: "agent:remote:main",
      lastActiveSessionKey: "agent:remote:main",
    });
    const sessionCredential = ["page", "session", "credential"].join("-");
    persistSessionToken(expectedGatewayUrl("/openclaw"), sessionCredential);
    const before = [...Array(localStorage.length)].map((_, index) => localStorage.key(index));

    expect(resolvePageGatewaySettings(remote)).toMatchObject({
      gatewayUrl: expectedGatewayUrl("/openclaw"),
      token: sessionCredential,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index))).toEqual(
      before,
    );
  });

  it("defaults the chat send shortcut to enter", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    expect(loadSettings().chatSendShortcut).toBe("enter");
  });

  it("infers base path from nested pathname when configured base path is not set", () => {
    setTestLocation({
      protocol: "http:",
      host: "gateway.example:18789",
      pathname: "/apps/openclaw/chat",
    });

    expect(loadSettings().gatewayUrl).toBe(expectedGatewayUrl("/apps/openclaw"));
  });

  it("skips node sessionStorage accessors that warn without a storage file", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    setControlUiBasePath(undefined);
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(expectedGatewayUrl(""));
    expect(settings.token).toBe("");
    expect(
      warningSpy.mock.calls.some(
        ([message]) => message === "`--localstorage-file` was provided without a valid path",
      ),
    ).toBe(false);
  });

  it("ignores and scrubs legacy persisted tokens", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    sessionStorage.setItem("openclaw.control.token.v1", "legacy-session-token");
    const gatewayUrl = "wss://gateway.example:8443/openclaw";
    const scopedKey = `openclaw.control.settings.v1:${gatewayUrl}`;
    localStorage.setItem(
      scopedKey,
      JSON.stringify({
        gatewayUrl,
        token: "persisted-token",
        sessionKey: "agent",
      }),
    );
    localStorage.setItem(
      "openclaw.control.currentGateway.v1:wss://gateway.example:8443",
      gatewayUrl,
    );

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(gatewayUrl);
    expect(settings.token).toBe("");
    expect(settings.sessionKey).toBe("agent");
    const rewritten = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(rewritten.token).toBeUndefined();
    expect(rewritten.sessionsByGateway).toEqual({
      "wss://gateway.example:8443/openclaw": {
        sessionKey: "agent",
        lastActiveSessionKey: "agent",
      },
    });
    expect(sessionStorage.length).toBe(0);
  });

  it("loads the current-tab token from sessionStorage", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "session-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
      textScale: 100,
    });

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(gwUrl);
    expect(settings.token).toBe("session-token");
  });

  it("does not reuse a session token for a different gatewayUrl", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const otherUrl = "wss://other-gateway.example:8443";
    saveSettings({
      gatewayUrl: gwUrl,
      token: "gateway-a-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });

    saveSettings({
      gatewayUrl: otherUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(gwUrl);
    expect(settings.token).toBe("gateway-a-token");
  });

  it("does not persist gateway tokens when saving settings", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "memory-only-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });
    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(gwUrl);
    expect(settings.token).toBe("memory-only-token");

    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).toEqual({
      gatewayUrl: gwUrl,
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      chatPersistCommentary: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
      textScale: 100,
      sessionsByGateway: {
        [gwUrl]: {
          sessionKey: "main",
          lastActiveSessionKey: "main",
        },
      },
    });
    expect(sessionStorage.length).toBe(1);
  });

  it("persists sidebar entries across save and load, normalizing bad values", () => {
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
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: ["route:tasks", "route:cron"],
      textScale: 100,
    });

    expect(loadSettings().sidebarEntries).toEqual(["route:tasks", "route:cron"]);
    expect(loadSettings().navWidth).toBe(258);

    // Corrupt the persisted list; load falls back to the default pinned set.
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    const persisted = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<
      string,
      unknown
    >;
    persisted.sidebarEntries = "route:tasks";
    persisted.navWidth = 220;
    localStorage.setItem(scopedKey, JSON.stringify(persisted));

    expect(loadSettings().sidebarEntries).toEqual(["route:cron", "route:plugins"]);
    expect(loadSettings().navWidth).toBe(258);
  });

  it("migrates the legacy route-only list once and writes only sidebarEntries", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    const legacy = makeSettings(gwUrl) as unknown as Record<string, unknown>;
    delete legacy.sidebarEntries;
    legacy.sidebarPinnedRoutes = ["usage", "tasks", "usage", "worktrees", 7];
    localStorage.setItem(scopedKey, JSON.stringify(legacy));

    expect(loadSettings().sidebarEntries).toEqual(["route:usage", "route:tasks"]);
    const migrated = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<string, unknown>;
    expect(migrated.sidebarEntries).toEqual(["route:usage", "route:tasks"]);
    expect(migrated).not.toHaveProperty("sidebarPinnedRoutes");
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
      splitRatio: 0.6,
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

  it("clears the current-tab token when saving an empty token", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "stale-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });

    expect(loadSettings().token).toBe("");
    expect(sessionStorage.length).toBe(0);
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
      splitRatio: 0.6,
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

  it("persists and parses a chat split layout", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const settings = loadSettings();
    const chatSplitLayout = {
      columns: [
        { id: "c1", panes: [{ id: "p1", sessionKey: "main" }], paneWeights: [1] },
        { id: "c2", panes: [{ id: "p2", sessionKey: "agent:main:work" }], paneWeights: [1] },
      ],
      columnWeights: [0.4, 0.6],
      activePaneId: "p2",
    };

    saveSettings({ ...settings, chatSplitLayout });

    expect(loadSettings().chatSplitLayout).toEqual(chatSplitLayout);
  });

  it("persists the last dashboard face and active tab per session", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const settings = loadSettings();
    const boardSessionViews = {
      "agent:main:main": {
        face: "dashboard" as const,
        activeTabId: "research",
        reopenDockByTab: { research: "left" as const },
      },
      "agent:main:plain": { face: "chat" as const },
    };

    saveSettings({ ...settings, boardSessionViews });

    expect(loadSettings().boardSessionViews).toEqual(boardSessionViews);
  });

  it("drops invalid stored dashboard view settings", () => {
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
        boardSessionViews: {
          "agent:main:main": { face: "grid", activeTabId: "research" },
        },
      }),
    );

    expect(loadSettings().boardSessionViews).toEqual({});
  });

  it("omits an invalid stored chat split layout", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const gwUrl = expectedGatewayUrl("");
    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({ gatewayUrl: gwUrl, chatSplitLayout: { columns: "invalid" } }),
    );

    expect(loadSettings().chatSplitLayout).toBeUndefined();
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
      splitRatio: 0.6,
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
        splitRatio: 0.6,
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

  it("scopes persisted session selection per gateway", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway-a.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(gwUrl);
    expect(settings.sessionKey).toBe("agent:test_old:main");
    expect(settings.lastActiveSessionKey).toBe("agent:test_old:main");
  });

  it("caps persisted session scopes to the most recent gateways", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:wss://gateway.example:8443`;

    // Pre-seed sessionsByGateway with 11 stale gateway entries so the next
    // saveSettings call pushes the total to 12 and triggers the cap (10).
    const staleEntries: Record<string, { sessionKey: string; lastActiveSessionKey: string }> = {};
    for (let i = 0; i < 11; i += 1) {
      staleEntries[`wss://stale-${i}.example:8443`] = {
        sessionKey: `agent:stale_${i}:main`,
        lastActiveSessionKey: `agent:stale_${i}:main`,
      };
    }
    localStorage.setItem(scopedKey, JSON.stringify({ sessionsByGateway: staleEntries }));

    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "agent:current:main",
      lastActiveSessionKey: "agent:current:main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });

    const persisted = JSON.parse(localStorage.getItem(scopedKey) ?? "{}");

    const scopedSessions = persisted.sessionsByGateway as Record<
      string,
      { sessionKey: string; lastActiveSessionKey: string }
    >;
    expect(scopedSessions["wss://gateway.example:8443"]).toEqual({
      sessionKey: "agent:current:main",
      lastActiveSessionKey: "agent:current:main",
    });
    expect(Object.keys(scopedSessions)).toEqual([
      "wss://stale-2.example:8443",
      "wss://stale-3.example:8443",
      "wss://stale-4.example:8443",
      "wss://stale-5.example:8443",
      "wss://stale-6.example:8443",
      "wss://stale-7.example:8443",
      "wss://stale-8.example:8443",
      "wss://stale-9.example:8443",
      "wss://stale-10.example:8443",
      "wss://gateway.example:8443",
    ]);
  });

  it("does not let a saved sibling base path override the current page gateway", () => {
    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-a/" });
    setControlUiBasePath("/gateway-a");
    saveSettings(makeSettings(expectedGatewayUrl("/gateway-a")));

    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-b/" });
    setControlUiBasePath("/gateway-b");

    expect(loadSettings().gatewayUrl).toBe(expectedGatewayUrl("/gateway-b"));
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeNull();
  });

  it("keeps custom gateway selections isolated per Control UI base path", () => {
    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-a/" });
    setControlUiBasePath("/gateway-a");
    saveSettings(makeSettings("wss://remote-a.example.com", { sessionKey: "agent:a:main" }));

    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-b/" });
    setControlUiBasePath("/gateway-b");
    saveSettings(makeSettings("wss://remote-b.example.com", { sessionKey: "agent:b:main" }));

    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-a/" });
    setControlUiBasePath("/gateway-a");
    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://remote-a.example.com",
      sessionKey: "agent:a:main",
    });

    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-b/" });
    setControlUiBasePath("/gateway-b");
    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://remote-b.example.com",
      sessionKey: "agent:b:main",
    });
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
