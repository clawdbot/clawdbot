// @vitest-environment node
// Gateway URL derivation, tab-local token handling, and per-gateway session
// scoping. Preference and layout persistence live in the dotted sibling files
// that keep each of them under the lint size budget.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectedGatewayUrl,
  installSettingsStorageLifecycle,
  makeUiSettings,
  setControlUiBasePath,
  setTestLocation,
} from "../test-helpers/settings-node.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadGatewaySessionSelection,
  loadSettings,
  persistSessionToken,
  resolvePageGatewaySettings,
  saveSettings,
} from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";

describe("resolveApplicationStartupSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips fragment bootstrap tokens without persisting them", () => {
    const startup = resolveApplicationStartupSettings(makeUiSettings("wss://gateway.example"), {
      pathname: "/",
      search: "",
      hash: "#gatewayUrl=wss%3A%2F%2Fgateway.example&bootstrapToken=boot-123&bootstrapProfile=owner",
    });

    expect(startup.pendingGatewayUrl).toBeNull();
    expect(startup.pendingGatewayToken).toBeNull();
    expect(startup.pendingBootstrapToken).toBe("boot-123");
    expect(startup.pendingBootstrapProfile).toBe("owner");
    expect(startup.settings.token).toBe("");
    expect(startup.location).toEqual({ pathname: "/", search: "", hash: "" });
  });

  it("carries fragment bootstrap tokens with changed gateway URLs", () => {
    const startup = resolveApplicationStartupSettings(makeUiSettings("wss://gateway-a.example"), {
      pathname: "/dash",
      search: "",
      hash: "#gatewayUrl=wss%3A%2F%2Fgateway-b.example&bootstrapToken=boot-456",
    });

    expect(startup.pendingGatewayUrl).toBe("wss://gateway-b.example");
    expect(startup.pendingGatewayToken).toBeNull();
    expect(startup.pendingBootstrapToken).toBe("boot-456");
    expect(startup.pendingBootstrapProfile).toBeNull();
    expect(startup.location).toEqual({ pathname: "/dash", search: "", hash: "" });
  });

  it("re-scopes the selected token when native auth changes only the Gateway and password", () => {
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
      gatewayUrl: "wss://gateway-b.example",
      password: "next-password",
    };
    const initial = makeUiSettings("wss://gateway-a.example", { token: "old-token" });

    const startup = resolveApplicationStartupSettings(initial, {
      pathname: "/",
      search: "",
      hash: "",
    });

    expect(startup.settings.token).toBe("");
    expect(startup.password).toBe("next-password");
  });
});

describe("loadSettings default gateway URL derivation", () => {
  installSettingsStorageLifecycle();

  it("keeps IPv6 dev-page default gateway hosts dialable", () => {
    setTestLocation({ protocol: "http:", host: "[::1]:5173", pathname: "/" });
    // A vite client script marks the page as dev, which reroutes the default
    // gateway to port 18789 via formatHostWithPort.
    vi.stubGlobal("document", {
      querySelector: (selector: string) => (selector.includes("@vite/client") ? {} : null),
      documentElement: { getAttribute: () => null },
    } as unknown as Document);

    try {
      expect(loadSettings().gatewayUrl).toBe("ws://[::1]:18789");
    } finally {
      // The document stub is unique to this test; drop it before the shared
      // afterEach persistence pass instead of leaving it to unstubAllGlobals.
      vi.unstubAllGlobals();
    }
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
    const remote = makeUiSettings("wss://remote.example:8443", {
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
      navWidth: 258,
      sidebarEntries: [],
      sessionsByGateway: {
        [gwUrl]: {
          sessionKey: "main",
          lastActiveSessionKey: "main",
        },
      },
    });
    expect(sessionStorage.length).toBe(1);
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
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });

    expect(loadSettings().token).toBe("");
    expect(sessionStorage.length).toBe(0);
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
      selectedAgentId: " OpenClaw ",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(gwUrl);
    expect(settings.sessionKey).toBe("agent:test_old:main");
    expect(settings.lastActiveSessionKey).toBe("agent:test_old:main");
    expect(settings.selectedAgentId).toBe("openclaw");
    expect(loadGatewaySessionSelection(gwUrl)).toEqual({
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
      selectedAgentId: "openclaw",
    });
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
    saveSettings(makeUiSettings(expectedGatewayUrl("/gateway-a")));

    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-b/" });
    setControlUiBasePath("/gateway-b");

    expect(loadSettings().gatewayUrl).toBe(expectedGatewayUrl("/gateway-b"));
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeNull();
  });

  it("keeps custom gateway selections isolated per Control UI base path", () => {
    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-a/" });
    setControlUiBasePath("/gateway-a");
    saveSettings(makeUiSettings("wss://remote-a.example.com", { sessionKey: "agent:a:main" }));

    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-b/" });
    setControlUiBasePath("/gateway-b");
    saveSettings(makeUiSettings("wss://remote-b.example.com", { sessionKey: "agent:b:main" }));

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
});
