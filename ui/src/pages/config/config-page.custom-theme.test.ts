/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext, ApplicationThemeServerSelection } from "../../app/context.ts";
import type { ImportedCustomTheme } from "../../app/custom-theme.ts";
import { loadSettings, patchSettings, type UiSettings } from "../../app/settings.ts";
import type { ThemeName } from "../../app/theme.ts";
import { createImportedCustomThemeFixture } from "../../test-helpers/custom-theme.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ConfigPage } from "./config-page.ts";
import type { CustomThemeImportOwner } from "./custom-theme-import-owner.ts";
import * as customTheme from "./custom-theme-import.ts";

const importCustomThemeFromUrl = vi.fn<typeof customTheme.importCustomThemeFromUrl>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

type CustomThemeImportState = {
  context: ApplicationContext;
  settings: UiSettings;
  customThemeImport: CustomThemeImportOwner["snapshot"];
  pageId: string;
  adoptThemeSettings: () => void;
  importCustomTheme: () => Promise<void>;
  clearCustomTheme: () => void;
  setCustomThemeImportUrl: (next: string) => void;
  setTheme: (theme: ThemeName) => void;
  customThemeImportOwner: CustomThemeImportOwner;
  retireCustomThemeImportForConfigMutation: () => void;
  synchronizeCustomThemeGatewayScope: (scope: string) => void;
  willUpdate: (changed: Map<PropertyKey, unknown>) => void;
};

function createCustomThemePage(settings: Partial<UiSettings> = {}) {
  const page = new ConfigPage();
  const state = page as unknown as CustomThemeImportState;
  const gatewayUrl = "ws://gateway.test";
  state.context = {
    gateway: { connection: { gatewayUrl } },
    runtimeConfig: {
      state: {
        configApplying: false,
        configAutoSaveStatus: "idle",
        configFormDirty: false,
        configLoading: false,
        configSaving: false,
        configSnapshot: { config: {}, valid: true, issues: [] },
        connected: true,
      },
    },
    theme: { recordServerSelection: vi.fn(), refresh: vi.fn(), serverSelection: null },
  } as unknown as ApplicationContext;
  state.customThemeImportOwner.connect(gatewayUrl, null);
  state.adoptThemeSettings = () => {
    state.settings = state.customThemeImportOwner.adoptSettings(
      state.settings,
      loadSettings(),
      state.context.theme.serverSelection,
    );
  };
  state.setCustomThemeImportUrl = (next) => state.customThemeImportOwner.setUrl(next);
  state.synchronizeCustomThemeGatewayScope = (scope) =>
    state.customThemeImportOwner.synchronizeScope(scope, state.context.theme.serverSelection);
  state.retireCustomThemeImportForConfigMutation = () =>
    state.customThemeImportOwner.retireForConfigMutation("You have unsaved changes");
  state.settings = { ...loadSettings(), ...settings };
  return { page, state };
}

function customThemeFixture(label: string, themeId: string): ImportedCustomTheme {
  return {
    ...createImportedCustomThemeFixture(),
    label,
    themeId,
    sourceUrl: `https://tweakcn.com/themes/${themeId}`,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  importCustomThemeFromUrl.mockReset();
  vi.spyOn(customTheme, "importCustomThemeFromUrl").mockImplementation(importCustomThemeFromUrl);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConfigPage custom theme import ownership", () => {
  it("keeps Replace then Clear authoritative when the replacement resolves late", async () => {
    const existingTheme = customThemeFixture("Existing", "existing");
    const replacement = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(replacement.promise);
    const { state } = createCustomThemePage({ theme: "custom", customTheme: existingTheme });
    state.setCustomThemeImportUrl("replacement");

    const pendingImport = state.importCustomTheme();
    state.clearCustomTheme();
    const clearMessage = state.customThemeImport.message;

    replacement.resolve(customThemeFixture("Replacement", "replacement"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme).toBeUndefined();
    expect(state.customThemeImport.url).toBe("replacement");
    expect(state.customThemeImport.message).toBe(clearMessage);
  });

  it("preserves a newer URL draft when the previous import resolves", async () => {
    const existingTheme = customThemeFixture("Existing", "existing");
    const replacement = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(replacement.promise);
    const { state } = createCustomThemePage({ theme: "knot", customTheme: existingTheme });
    state.setCustomThemeImportUrl("first");

    const pendingImport = state.importCustomTheme();
    state.setCustomThemeImportUrl("second");
    replacement.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("second");
    expect(state.customThemeImport.message).toBeNull();
    expect(state.settings.theme).toBe("knot");
    expect(state.settings.customTheme).toBe(existingTheme);
  });

  it("lets a newer import own state when the stale import settles first", async () => {
    const first = deferred<ImportedCustomTheme>();
    const second = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");

    const firstImport = state.importCustomTheme();
    state.setCustomThemeImportUrl("second");
    const secondImport = state.importCustomTheme();
    first.resolve(customThemeFixture("First", "first"));
    await firstImport;

    expect(state.customThemeImport.busy).toBe(true);
    expect(state.customThemeImport.url).toBe("second");
    expect(state.customThemeImport.message).toBeNull();
    expect(state.settings.customTheme).toBeUndefined();

    const secondTheme = customThemeFixture("Second", "second");
    second.resolve(secondTheme);
    await secondImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("");
    expect(state.customThemeImport.message?.kind).toBe("success");
    expect(state.settings.theme).toBe("custom");
    expect(state.settings.customTheme).toBe(secondTheme);
  });

  it("keeps a completed newer import final when the stale import settles last", async () => {
    const first = deferred<ImportedCustomTheme>();
    const second = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");

    const firstImport = state.importCustomTheme();
    state.setCustomThemeImportUrl("second");
    const secondImport = state.importCustomTheme();
    const secondTheme = customThemeFixture("Second", "second");
    second.resolve(secondTheme);
    await secondImport;
    const successMessage = state.customThemeImport.message;

    first.resolve(customThemeFixture("First", "first"));
    await firstImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("");
    expect(state.customThemeImport.message).toBe(successMessage);
    expect(state.settings.theme).toBe("custom");
    expect(state.settings.customTheme).toBe(secondTheme);
  });

  it("preserves a newer server-applied theme when an older import settles", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    patchSettings({ theme: "knot" });
    state.adoptThemeSettings();
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("");
    expect(state.customThemeImport.message?.kind).toBe("success");
    expect(state.settings.theme).toBe("knot");
    expect(state.settings.customTheme?.themeId).toBe("first");
  });

  it("revokes activation when server intent changes but the local mirror is equal", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { state } = createCustomThemePage();
    let serverSelection: ApplicationThemeServerSelection | null = null;
    state.context = {
      ...state.context,
      theme: {
        ...state.context.theme,
        get serverSelection() {
          return serverSelection;
        },
      },
    } as ApplicationContext;
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    serverSelection = {
      revision: 1,
      scope: "ws://gateway.test",
      theme: "claw",
    };
    state.adoptThemeSettings();
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme?.themeId).toBe("first");
  });

  it("retires an import when navigation leaves Appearance", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { state } = createCustomThemePage();
    state.pageId = "appearance";
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    state.pageId = "security";
    state.willUpdate(new Map([["pageId", "appearance"]]));
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("first");
    expect(state.customThemeImport.message).toBeNull();
    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme).toBeUndefined();
  });

  it("retires an import when the active Gateway scope changes", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { state } = createCustomThemePage();
    state.synchronizeCustomThemeGatewayScope("ws://gateway-a.test");
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    state.synchronizeCustomThemeGatewayScope("ws://gateway-b.test");
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("first");
    expect(state.customThemeImport.message).toBeNull();
    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme).toBeUndefined();
  });

  it("preserves a built-in selection made after the first import starts", async () => {
    const first = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(first.promise);
    const { state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");

    const pendingImport = state.importCustomTheme();
    state.setTheme("knot");
    first.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("");
    expect(state.customThemeImport.message?.kind).toBe("success");
    expect(state.settings.theme).toBe("knot");
    expect(state.settings.customTheme?.themeId).toBe("first");
  });

  it("honors a newer server Custom selection after an intervening built-in selection", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { state } = createCustomThemePage();
    let serverSelection: ApplicationThemeServerSelection | null = {
      revision: 1,
      scope: "ws://gateway.test",
      theme: "claw",
    };
    state.context = {
      ...state.context,
      theme: {
        ...state.context.theme,
        get serverSelection() {
          return serverSelection;
        },
      },
    } as ApplicationContext;
    state.customThemeImportOwner.connect("ws://gateway.test", serverSelection);
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    serverSelection = { revision: 2, scope: "ws://gateway.test", theme: "knot" };
    patchSettings({ theme: "knot" });
    state.adoptThemeSettings();
    serverSelection = { revision: 3, scope: "ws://gateway.test", theme: "custom" };
    state.adoptThemeSettings();
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.settings.theme).toBe("custom");
    expect(state.settings.customTheme?.themeId).toBe("first");
  });

  it("refuses to race an older pending full-config write", async () => {
    const { state } = createCustomThemePage();
    state.context = {
      ...state.context,
      runtimeConfig: {
        ...state.context.runtimeConfig,
        state: { ...state.context.runtimeConfig.state, configFormDirty: true },
      },
    } as ApplicationContext;
    state.setCustomThemeImportUrl("first");

    await state.importCustomTheme();

    expect(importCustomThemeFromUrl).not.toHaveBeenCalled();
    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.message).toEqual({
      kind: "error",
      text: "You have unsaved changes",
    });
  });

  it("waits for the initial canonical config before importing", async () => {
    const { state } = createCustomThemePage();
    state.context = {
      ...state.context,
      runtimeConfig: {
        ...state.context.runtimeConfig,
        state: {
          ...state.context.runtimeConfig.state,
          configLoading: true,
          configSnapshot: null,
        },
      },
    } as ApplicationContext;
    state.setCustomThemeImportUrl("first");

    await state.importCustomTheme();

    expect(importCustomThemeFromUrl).not.toHaveBeenCalled();
    expect(state.customThemeImport.message).toEqual({ kind: "error", text: "Loading…" });
  });

  it("retires a pending import when a full-config edit begins", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    state.retireCustomThemeImportForConfigMutation();
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.settings.customTheme).toBeUndefined();
    expect(state.customThemeImport.message).toEqual({
      kind: "error",
      text: "You have unsaved changes",
    });
  });

  it("retires an import when the page disconnects", async () => {
    const first = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(first.promise);
    const { page, state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    page.disconnectedCallback();
    first.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("first");
    expect(state.customThemeImport.message).toBeNull();
    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme).toBeUndefined();
  });
});
