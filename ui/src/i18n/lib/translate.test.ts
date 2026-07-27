// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { en } from "../locales/en.ts";
import type { Locale, TranslationMap } from "./types.ts";

vi.mock("./registry.ts", async () => {
  const actual = await vi.importActual<typeof import("./registry.ts")>("./registry.ts");
  return {
    ...actual,
    loadLazyLocaleTranslation: vi.fn(),
  };
});

import { loadLazyLocaleTranslation } from "./registry.ts";
import { i18n } from "./translate.ts";

type I18nInternals = {
  locale: Locale;
  localeRequestGeneration: number;
  pendingLocale: Locale | null;
  subscribers: Set<(locale: Locale) => void>;
  translations: Partial<Record<Locale, TranslationMap>>;
};

const internals = i18n as unknown as I18nInternals;
const loadTranslation = vi.mocked(loadLazyLocaleTranslation);
const german = { common: { health: "Gesundheit" } } satisfies TranslationMap;
const spanish = { common: { health: "Salud" } } satisfies TranslationMap;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("I18nManager pending locale retry", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    loadTranslation.mockReset();
    internals.locale = "en";
    internals.localeRequestGeneration = 0;
    internals.pendingLocale = null;
    internals.subscribers.clear();
    internals.translations = { en };
    i18n.setLocaleLoadRecovery(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies and notifies when a failed locale load is retried after recovery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadTranslation.mockRejectedValueOnce(new Error("gateway unavailable"));
    loadTranslation.mockResolvedValueOnce(german);
    const subscriber = vi.fn();
    const unsubscribe = i18n.subscribe(subscriber);

    await i18n.setLocale("de");

    expect(i18n.getLocale()).toBe("en");
    expect(internals.pendingLocale).toBe("de");
    expect(subscriber).not.toHaveBeenCalled();

    i18n.retryPendingLocale();
    await vi.waitFor(() => expect(i18n.getLocale()).toBe("de"));

    expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
    expect(internals.pendingLocale).toBeNull();
    unsubscribe();
  });

  it("does nothing when no locale load is pending", () => {
    const subscriber = vi.fn();
    const unsubscribe = i18n.subscribe(subscriber);

    i18n.retryPendingLocale();

    expect(loadTranslation).not.toHaveBeenCalled();
    expect(i18n.getLocale()).toBe("en");
    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("clears an abandoned pending target after another locale succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadTranslation.mockRejectedValueOnce(new Error("gateway unavailable"));
    loadTranslation.mockResolvedValueOnce(spanish);

    await i18n.setLocale("de");
    await i18n.setLocale("es");
    i18n.retryPendingLocale();

    expect(i18n.getLocale()).toBe("es");
    expect(internals.pendingLocale).toBeNull();
    expect(loadTranslation).toHaveBeenCalledTimes(2);
  });

  it("records a repeat failure so a later retry can still recover", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadTranslation
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(new Error("gateway still unavailable"))
      .mockResolvedValueOnce(german);

    await i18n.setLocale("de");
    i18n.retryPendingLocale();
    await vi.waitFor(() => {
      expect(loadTranslation).toHaveBeenCalledTimes(2);
      expect(internals.pendingLocale).toBe("de");
    });

    i18n.retryPendingLocale();
    await vi.waitFor(() => expect(i18n.getLocale()).toBe("de"));

    expect(loadTranslation).toHaveBeenCalledTimes(3);
    expect(internals.pendingLocale).toBeNull();
  });

  it("persists and reports a repeated module-import failure while keeping it pending", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const persistedLocalesAtHook: Array<string | null> = [];
    const onUnrecoverableLocaleLoad = vi.fn(() => {
      persistedLocalesAtHook.push(localStorage.getItem("openclaw.i18n.locale"));
    });
    i18n.setLocaleLoadRecovery({
      isUnrecoverableError: (error) =>
        error instanceof Error &&
        /failed to fetch dynamically imported module/i.test(error.message),
      onUnrecoverableLocaleLoad,
    });
    loadTranslation
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(
        new Error("Failed to fetch dynamically imported module: /assets/fr-abc123.js"),
      );

    await i18n.setLocale("fr");
    i18n.retryPendingLocale();
    await vi.waitFor(() => expect(loadTranslation).toHaveBeenCalledTimes(2));

    expect(onUnrecoverableLocaleLoad).toHaveBeenCalledExactlyOnceWith("fr");
    expect(persistedLocalesAtHook).toEqual(["fr"]);
    expect(localStorage.getItem("openclaw.i18n.locale")).toBe("fr");
    expect(internals.pendingLocale).toBe("fr");
  });

  it("does not report a repeated non-import failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onUnrecoverableLocaleLoad = vi.fn();
    i18n.setLocaleLoadRecovery({
      isUnrecoverableError: (error) =>
        error instanceof Error &&
        /failed to fetch dynamically imported module/i.test(error.message),
      onUnrecoverableLocaleLoad,
    });
    loadTranslation
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(new Error("request failed"));

    await i18n.setLocale("fr");
    i18n.retryPendingLocale();
    await vi.waitFor(() => expect(loadTranslation).toHaveBeenCalledTimes(2));

    expect(onUnrecoverableLocaleLoad).not.toHaveBeenCalled();
    expect(internals.pendingLocale).toBe("fr");
  });

  it("ignores an older failure after a newer locale succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const germanLoad = deferred<TranslationMap | null>();
    const spanishLoad = deferred<TranslationMap | null>();
    loadTranslation
      .mockReturnValueOnce(germanLoad.promise)
      .mockReturnValueOnce(spanishLoad.promise);

    const setGerman = i18n.setLocale("de");
    const setSpanish = i18n.setLocale("es");
    spanishLoad.resolve(spanish);
    await setSpanish;
    germanLoad.reject(new Error("late German failure"));
    await setGerman;
    i18n.retryPendingLocale();

    expect(i18n.getLocale()).toBe("es");
    expect(internals.pendingLocale).toBeNull();
    expect(loadTranslation).toHaveBeenCalledTimes(2);
  });

  it("preserves a newer failed target when an older load succeeds late", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const germanLoad = deferred<TranslationMap | null>();
    const spanishLoad = deferred<TranslationMap | null>();
    loadTranslation
      .mockReturnValueOnce(germanLoad.promise)
      .mockReturnValueOnce(spanishLoad.promise)
      .mockResolvedValueOnce(spanish);

    const setGerman = i18n.setLocale("de");
    const setSpanish = i18n.setLocale("es");
    spanishLoad.reject(new Error("Spanish load failed"));
    await setSpanish;
    germanLoad.resolve(german);
    await setGerman;

    expect(i18n.getLocale()).toBe("en");
    expect(internals.pendingLocale).toBe("es");

    i18n.retryPendingLocale();
    await vi.waitFor(() => expect(i18n.getLocale()).toBe("es"));

    expect(loadTranslation).toHaveBeenCalledTimes(3);
    expect(internals.pendingLocale).toBeNull();
  });
});
