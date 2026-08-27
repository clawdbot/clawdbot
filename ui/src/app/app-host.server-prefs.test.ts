/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import type { ApplicationContext } from "./context.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

type ShellServerPreferencesState = {
  runtime: { context: ApplicationContext };
  reconcileCommittedServerUiPrefs: (
    runtimeConfig: ApplicationContext["runtimeConfig"],
    needsRefresh: boolean,
    retainedLocal?: boolean,
  ) => void;
  reconcileServerUiPrefs: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
};

describe("OpenClaw shell locale preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });

  afterEach(() => {
    resetServerUiPrefsSync();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses canonical server locale provenance and clears a stale local pin", () => {
    localStorage.setItem("openclaw.i18n.locale", "fr");
    const setLocale = vi.spyOn(i18n, "setLocale").mockResolvedValue();
    const useSystemLocale = vi.spyOn(i18n, "useSystemLocale").mockResolvedValue();
    const state: {
      configSnapshot: {
        config: { ui: { prefs: Record<string, unknown> } };
        hash: string;
      };
    } = {
      configSnapshot: {
        config: { ui: { prefs: { locale: "de" } } },
        hash: "locale-config-hash",
      },
    };
    const runtimeConfig = { state } as unknown as ApplicationContext["runtimeConfig"];
    const refreshTheme = vi.fn();
    const context = {
      gateway: { connection: { gatewayUrl: "ws://locale.test" } },
      navigation: { update: vi.fn() },
      theme: { refresh: refreshTheme },
      runtimeConfig,
    } as unknown as ApplicationContext;
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellServerPreferencesState;
    shell.runtime = { context };

    shell.reconcileServerUiPrefs(runtimeConfig);
    shell.reconcileServerUiPrefs(runtimeConfig);
    state.configSnapshot = {
      config: { ui: { prefs: {} } },
      hash: "locale-config-cleared-hash",
    };
    shell.reconcileServerUiPrefs(runtimeConfig);
    shell.reconcileServerUiPrefs(runtimeConfig);

    expect(setLocale).toHaveBeenCalledExactlyOnceWith("de");
    expect(useSystemLocale).toHaveBeenCalledOnce();
    expect(loadSettings().locale).toBeUndefined();
  });

  it("keeps a retained device-local locale instead of realigning to the rejected server value", () => {
    const setLocale = vi.spyOn(i18n, "setLocale").mockResolvedValue();
    const useSystemLocale = vi.spyOn(i18n, "useSystemLocale").mockResolvedValue();
    const state = {
      configSnapshot: {
        config: { ui: { prefs: { locale: "de" } } },
        hash: "locale-config-hash",
      },
    };
    const runtimeConfig = { state } as unknown as ApplicationContext["runtimeConfig"];
    const refreshTheme = vi.fn();
    const context = {
      gateway: { connection: { gatewayUrl: "ws://locale.test" } },
      navigation: { update: vi.fn() },
      theme: { refresh: refreshTheme },
      runtimeConfig,
    } as unknown as ApplicationContext;
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellServerPreferencesState;
    shell.runtime = { context };

    shell.reconcileServerUiPrefs(runtimeConfig);
    refreshTheme.mockClear();
    patchSettings({ locale: "fr" });
    shell.reconcileCommittedServerUiPrefs(runtimeConfig, false, true);

    expect(setLocale).toHaveBeenNthCalledWith(1, "de");
    expect(setLocale).toHaveBeenNthCalledWith(2, "fr");
    expect(useSystemLocale).not.toHaveBeenCalled();
    expect(loadSettings().locale).toBe("fr");
    expect(refreshTheme).toHaveBeenCalledOnce();
  });

  it("publishes authored theme changes when the local mirror needs no patch", () => {
    const state = {
      configSnapshot: {
        config: { ui: { prefs: { theme: "custom" } } },
        hash: "theme-custom",
      },
    };
    const runtimeConfig = { state } as unknown as ApplicationContext["runtimeConfig"];
    const recordServerSelection = vi.fn();
    const context = {
      gateway: { connection: { gatewayUrl: "ws://theme.test" } },
      navigation: { update: vi.fn() },
      theme: { recordServerSelection, refresh: vi.fn(), serverSelection: null },
      runtimeConfig,
    } as unknown as ApplicationContext;
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellServerPreferencesState;
    shell.runtime = { context };

    shell.reconcileServerUiPrefs(runtimeConfig);
    expect(recordServerSelection).toHaveBeenLastCalledWith("custom", "ws://theme.test");

    state.configSnapshot = {
      config: { ui: { prefs: { theme: "claw" } } },
      hash: "theme-claw",
    };
    shell.reconcileServerUiPrefs(runtimeConfig);
    expect(recordServerSelection).toHaveBeenLastCalledWith("claw", "ws://theme.test");
    expect(loadSettings().theme).toBe("claw");
  });
});
