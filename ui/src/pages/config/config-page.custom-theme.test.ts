/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import * as customTheme from "../../app/custom-theme.ts";
import type { ImportedCustomTheme } from "../../app/custom-theme.ts";
import { loadSettings, type UiSettings } from "../../app/settings.ts";
import type { ThemeName } from "../../app/theme.ts";
import { createImportedCustomThemeFixture } from "../../test-helpers/custom-theme.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ConfigPage } from "./config-page.ts";

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
  customThemeImportUrl: string;
  customThemeImportBusy: boolean;
  customThemeImportMessage: { kind: "success" | "error"; text: string } | null;
  importCustomTheme: () => Promise<void>;
  clearCustomTheme: () => void;
  setCustomThemeImportUrl: (next: string) => void;
  setTheme: (theme: ThemeName) => void;
};

function createCustomThemePage(settings: Partial<UiSettings> = {}) {
  const page = new ConfigPage();
  const state = page as unknown as CustomThemeImportState;
  state.context = { theme: { refresh: vi.fn() } } as unknown as ApplicationContext;
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
    const clearMessage = state.customThemeImportMessage;

    replacement.resolve(customThemeFixture("Replacement", "replacement"));
    await pendingImport;

    expect(state.customThemeImportBusy).toBe(false);
    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme).toBeUndefined();
    expect(state.customThemeImportUrl).toBe("replacement");
    expect(state.customThemeImportMessage).toBe(clearMessage);
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

    expect(state.customThemeImportBusy).toBe(false);
    expect(state.customThemeImportUrl).toBe("second");
    expect(state.customThemeImportMessage).toBeNull();
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

    expect(state.customThemeImportBusy).toBe(true);
    expect(state.customThemeImportUrl).toBe("second");
    expect(state.customThemeImportMessage).toBeNull();
    expect(state.settings.customTheme).toBeUndefined();

    const secondTheme = customThemeFixture("Second", "second");
    second.resolve(secondTheme);
    await secondImport;

    expect(state.customThemeImportBusy).toBe(false);
    expect(state.customThemeImportUrl).toBe("");
    expect(state.customThemeImportMessage?.kind).toBe("success");
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
    const successMessage = state.customThemeImportMessage;

    first.resolve(customThemeFixture("First", "first"));
    await firstImport;

    expect(state.customThemeImportBusy).toBe(false);
    expect(state.customThemeImportUrl).toBe("");
    expect(state.customThemeImportMessage).toBe(successMessage);
    expect(state.settings.theme).toBe("custom");
    expect(state.settings.customTheme).toBe(secondTheme);
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

    expect(state.customThemeImportBusy).toBe(false);
    expect(state.customThemeImportUrl).toBe("first");
    expect(state.customThemeImportMessage).toBeNull();
    expect(state.settings.theme).toBe("knot");
    expect(state.settings.customTheme).toBeUndefined();
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

    expect(state.customThemeImportBusy).toBe(false);
    expect(state.customThemeImportUrl).toBe("first");
    expect(state.customThemeImportMessage).toBeNull();
    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme).toBeUndefined();
  });
});
