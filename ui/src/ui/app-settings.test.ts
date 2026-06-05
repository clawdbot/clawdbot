// Control UI tests cover app settings behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  applyResolvedTheme,
  applySettings,
  applySettingsFromUrl,
  setTabFromRoute,
  syncThemeWithSettings,
} from "./app-settings.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";

type Tab =
  | "agents"
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "infrastructure"
  | "aiAgents"
  | "debug"
  | "logs";

type SettingsHost = {
  settings: {
    gatewayUrl: string;
    token: string;
    sessionKey: string;
    lastActiveSessionKey: string;
    theme: ThemeName;
    themeMode: ThemeMode;
    chatShowThinking: boolean;
    chatShowToolCalls: boolean;
    splitRatio: number;
    navCollapsed: boolean;
    navWidth: number;
    navGroupsCollapsed: Record<string, boolean>;
    borderRadius: number;
    textScale?: import("./storage.ts").TextScaleStop;
    customTheme?: import("./custom-theme.ts").ImportedCustomTheme;
  };
  theme: ThemeName & ThemeMode;
  themeMode: ThemeMode;
  themeResolved: import("./theme.ts").ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  tab: Tab;
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  password?: string;
  basePath: string;
  themeMedia: MediaQueryList | null;
  themeMediaHandler: ((event: MediaQueryListEvent) => void) | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  pendingGatewayUrl?: string | null;
  pendingGatewayToken?: string | null;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: null;
  dreamingModeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: null;
  wikiMemoryPalaceLoading: boolean;
  wikiMemoryPalaceError: string | null;
  wikiMemoryPalace: null;
};

function setTestWindowUrl(urlString: string) {
  const current = new URL(urlString);
  const history = {
    replaceState: vi.fn((_state: unknown, _title: string, nextUrl: string | URL) => {
      const next = new URL(String(nextUrl), current.toString());
      current.href = next.toString();
      current.protocol = next.protocol;
      current.host = next.host;
      current.pathname = next.pathname;
      current.search = next.search;
      current.hash = next.hash;
    }),
  };
  const locationLike = {
    get href() {
      return current.toString();
    },
    get protocol() {
      return current.protocol;
    },
    get host() {
      return current.host;
    },
    get pathname() {
      return current.pathname;
    },
    get search() {
      return current.search;
    },
    get hash() {
      return current.hash;
    },
  };
  vi.stubGlobal("window", {
    location: locationLike,
    history,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis);
  vi.stubGlobal("location", locationLike as Location);
  return { history, location: locationLike };
}

const createHost = (tab: Tab): SettingsHost => ({
  settings: {
    gatewayUrl: "",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatShowThinking: true,
    chatShowToolCalls: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 220,
    navGroupsCollapsed: {},
    borderRadius: 50,
    textScale: 100,
  },
  theme: "claw" as unknown as ThemeName & ThemeMode,
  themeMode: "system",
  themeResolved: "dark",
  applySessionKey: "main",
  sessionKey: "main",
  tab,
  connected: false,
  chatHasAutoScrolled: false,
  logsAtBottom: false,
  eventLog: [],
  eventLogBuffer: [],
  password: "",
  basePath: "",
  themeMedia: null,
  themeMediaHandler: null,
  logsPollInterval: null,
  debugPollInterval: null,
  pendingGatewayUrl: null,
  pendingGatewayToken: null,
  dreamingStatusLoading: false,
  dreamingStatusError: null,
  dreamingStatus: null,
  dreamingModeSaving: false,
  dreamDiaryLoading: false,
  dreamDiaryActionLoading: false,
  dreamDiaryActionMessage: null,
  dreamDiaryActionArchivePath: null,
  dreamDiaryError: null,
  dreamDiaryPath: null,
  dreamDiaryContent: null,
  wikiImportInsightsLoading: false,
  wikiImportInsightsError: null,
  wikiImportInsights: null,
  wikiMemoryPalaceLoading: false,
  wikiMemoryPalaceError: null,
  wikiMemoryPalace: null,
});

describe("setTabFromRoute", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts and stops log polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "logs");
    expect(host.debugPollInterval).toBeNull();
    expect(host.logsPollInterval).not.toBe(host.debugPollInterval);

    setTabFromRoute(host, "chat");
    expect(host.logsPollInterval).toBeNull();
  });

  it("starts and stops debug polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "debug");
    expect(host.logsPollInterval).toBeNull();
    expect(host.debugPollInterval).not.toBe(host.logsPollInterval);

    setTabFromRoute(host, "chat");
    expect(host.debugPollInterval).toBeNull();
  });

  it("re-resolves the active palette when only themeMode changes", () => {
    const host = createHost("chat");
    host.settings.theme = "knot";
    host.settings.themeMode = "dark";
    host.theme = "knot" as unknown as ThemeName & ThemeMode;
    host.themeMode = "dark";
    host.themeResolved = "openknot";

    applySettings(host, {
      ...host.settings,
      themeMode: "light",
    });

    expect(host.theme).toBe("knot");
    expect(host.themeMode).toBe("light");
    expect(host.themeResolved).toBe("openknot-light");
  });

  it("applies normalized browser-local text scale", () => {
    const host = createHost("chat");

    applySettings(host, {
      ...host.settings,
      textScale: 125,
    });

    expect(host.settings.textScale).toBe(125);
    expect(document.documentElement.style.getPropertyValue("--control-ui-text-scale")).toBe("1.25");
  });

  it("syncs both theme family and mode from persisted settings", () => {
    const host = createHost("chat");
    host.settings.theme = "dash";
    host.settings.themeMode = "light";

    syncThemeWithSettings(host);

    expect(host.theme).toBe("dash");
    expect(host.themeMode).toBe("light");
    expect(host.themeResolved).toBe("dash-light");
  });

  it("falls back to claw when custom is selected without a stored custom theme", () => {
    const host = createHost("chat");
    host.settings.theme = "custom";
    host.settings.themeMode = "dark";

    syncThemeWithSettings(host);

    expect(host.theme).toBe("claw");
    expect(host.settings.theme).toBe("claw");
    expect(host.themeResolved).toBe("dark");
  });

  it("applies named system themes on OS preference changes", () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: (_name: string, handler: (event: MediaQueryListEvent) => void) => {
        listeners.push(handler);
      },
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("matchMedia", matchMedia);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia,
    });

    const host = createHost("chat");
    host.settings.theme = "knot" as unknown as ThemeName & ThemeMode;
    host.settings.themeMode = "system";

    syncThemeWithSettings(host);
    listeners[0]?.({ matches: true } as MediaQueryListEvent);
    expect(host.themeResolved).toBe("openknot");

    listeners[0]?.({ matches: false } as MediaQueryListEvent);
    expect(host.themeResolved).toBe("openknot");
  });

  it("normalizes light family themes to the shared light CSS token", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" } as CSSStyleDeclaration & { colorScheme: string },
    };
    vi.stubGlobal("document", { documentElement: root } as Document);

    const host = createHost("chat");
    applyResolvedTheme(host, "dash-light");

    expect(host.themeResolved).toBe("dash-light");
    expect(root.dataset.theme).toBe("dash-light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("applies imported custom light themes as light-mode tokens", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" } as CSSStyleDeclaration & { colorScheme: string },
    };
    vi.stubGlobal("document", { documentElement: root } as Document);

    const host = createHost("chat");
    host.settings.customTheme = createImportedCustomThemeFixture();
    applyResolvedTheme(host, "custom-light");

    expect(host.themeResolved).toBe("custom-light");
    expect(root.dataset.theme).toBe("custom-light");
    expect(root.style.colorScheme).toBe("light");
  });
});

describe("applySettingsFromUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestWindowUrl("https://control.example/ui/overview");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hydrates query token params and strips them from the URL", () => {
    setTestWindowUrl("https://control.example/ui/overview?token=abc123&password=sekret");
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/openclaw";

    applySettingsFromUrl(host);

    expect(host.settings.token).toBe("abc123");
    expect(window.location.search).toBe("");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );
  });

  it("prefers fragment tokens over legacy query tokens when both are present", () => {
    setTestWindowUrl("https://control.example/ui/overview?token=query-token#token=hash-token");
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/openclaw";

    applySettingsFromUrl(host);

    expect(host.settings.token).toBe("hash-token");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("hydrates native Mac app auth before the first connection", () => {
    setTestWindowUrl("https://control.example/ui/chat");
    (
      window as unknown as {
        __OPENCLAW_NATIVE_CONTROL_AUTH__?: {
          gatewayUrl?: string;
          token?: string;
          password?: string;
        };
      }
    )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
      gatewayUrl: "wss://control.example/ui/",
      token: "device-token",
      password: "shared-password",
    };
    const host = createHost("chat");

    applySettingsFromUrl(host);

    expect(host.settings.gatewayUrl).toBe("wss://control.example/ui/");
    expect(host.settings.token).toBe("device-token");
    expect(host.password).toBe("shared-password");
    expect(
      (
        window as unknown as {
          __OPENCLAW_NATIVE_CONTROL_AUTH__?: unknown;
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"],
    ).toBeUndefined();
  });

  it("resets stale persisted session selection to main when a token is supplied without a session", () => {
    setTestWindowUrl("https://control.example/chat#token=test-token");
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://localhost:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("main");
    expect(host.settings.sessionKey).toBe("main");
    expect(host.settings.lastActiveSessionKey).toBe("main");
  });

  it("characterizes token, session, and gateway URL combinations", () => {
    const scenarios = [
      {
        name: "same gateway applies token and session immediately",
        url: "https://control.example/chat?session=agent%3Atest_new%3Amain#token=token-a",
        settingsGatewayUrl: "ws://gateway-a.example:18789",
        settingsToken: "",
        expectedToken: "token-a",
        expectedSession: "agent:test_new:main",
        expectedPendingGatewayUrl: null,
        expectedPendingGatewayToken: null,
        expectedSearch: "?session=agent%3Atest_new%3Amain",
      },
      {
        name: "different gateway defers token and keeps explicit session",
        url: "https://control.example/chat?gatewayUrl=ws%3A%2F%2Fgateway-b.example%3A18789&session=agent%3Atest_new%3Amain#token=token-b",
        settingsGatewayUrl: "ws://gateway-a.example:18789",
        settingsToken: "",
        expectedToken: "",
        expectedSession: "agent:test_new:main",
        expectedPendingGatewayUrl: "ws://gateway-b.example:18789",
        expectedPendingGatewayToken: "token-b",
        expectedSearch: "?session=agent%3Atest_new%3Amain",
      },
      {
        name: "different gateway defers token without changing session",
        url: "https://control.example/chat?gatewayUrl=ws%3A%2F%2Fgateway-b.example%3A18789#token=token-c",
        settingsGatewayUrl: "ws://gateway-a.example:18789",
        settingsToken: "",
        expectedToken: "",
        expectedSession: "agent:test_old:main",
        expectedPendingGatewayUrl: "ws://gateway-b.example:18789",
        expectedPendingGatewayToken: "token-c",
        expectedSearch: "",
      },
      {
        name: "different gateway without token clears pending token",
        url: "https://control.example/chat?gatewayUrl=ws%3A%2F%2Fgateway-b.example%3A18789&session=agent%3Atest_new%3Amain",
        settingsGatewayUrl: "ws://gateway-a.example:18789",
        settingsToken: "existing-token",
        expectedToken: "existing-token",
        expectedSession: "agent:test_new:main",
        expectedPendingGatewayUrl: "ws://gateway-b.example:18789",
        expectedPendingGatewayToken: null,
        expectedSearch: "?session=agent%3Atest_new%3Amain",
      },
    ] as const;

    for (const scenario of scenarios) {
      setTestWindowUrl(scenario.url);
      const host = createHost("chat");
      host.settings = {
        ...host.settings,
        gatewayUrl: scenario.settingsGatewayUrl,
        token: scenario.settingsToken,
        sessionKey: "agent:test_old:main",
        lastActiveSessionKey: "agent:test_old:main",
      };
      host.sessionKey = "agent:test_old:main";

      applySettingsFromUrl(host);

      expect(host.settings.token, scenario.name).toBe(scenario.expectedToken);
      expect(host.sessionKey, scenario.name).toBe(scenario.expectedSession);
      expect(host.settings.sessionKey, scenario.name).toBe(scenario.expectedSession);
      expect(host.settings.lastActiveSessionKey, scenario.name).toBe(scenario.expectedSession);
      expect(host.pendingGatewayUrl, scenario.name).toBe(scenario.expectedPendingGatewayUrl);
      expect(host.pendingGatewayToken, scenario.name).toBe(scenario.expectedPendingGatewayToken);
      expect(window.location.search, scenario.name).toBe(scenario.expectedSearch);
      expect(window.location.hash, scenario.name).toBe("");
    }
  });
});
