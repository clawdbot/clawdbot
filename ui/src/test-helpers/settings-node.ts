import { afterEach, beforeEach, vi } from "vitest";
import { loadSettings, saveSettings, type UiSettings } from "../app/settings.ts";
import { createStorageMock } from "./storage.ts";

/** Points the node-environment settings suites at a synthetic Control UI page URL. */
export function setTestLocation(params: { protocol: string; host: string; pathname: string }) {
  vi.stubGlobal("location", {
    protocol: params.protocol,
    host: params.host,
    hostname: params.host.replace(/:\d+$/, ""),
    pathname: params.pathname,
  } as Location);
}

export function setControlUiBasePath(value: string | undefined) {
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

export function expectedGatewayUrl(basePath: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${basePath}`;
}

export function makeUiSettings(
  gatewayUrl: string,
  overrides: Partial<UiSettings> = {},
): UiSettings {
  return {
    gatewayUrl,
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    colorVision: "standard",
    chatShowThinking: true,
    chatShowToolCalls: true,
    navCollapsed: false,
    navWidth: 258,
    sidebarEntries: [],
    ...overrides,
  };
}

/**
 * Gives each settings suite owned storage globals and drains the module-level
 * in-memory settings cache afterwards: without the trailing save/load pass a
 * leaked selection from one file would surface as another file's default.
 */
export function installSettingsStorageLifecycle(): void {
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
}
