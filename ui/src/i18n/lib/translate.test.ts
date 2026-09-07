// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  createStorageMock,
  installSafeLocalStorageForTesting,
} from "../../test-helpers/storage.ts";
import { createI18nManagerForTesting } from "./translate.test-support.ts";
import type { Locale, TranslationMap } from "./types.ts";

type I18nInternals = {
  pendingLocale: Locale | null;
  pendingLocaleShouldPersist: boolean;
};

const german = { common: { health: "Gesundheit" } } satisfies TranslationMap;
const spanish = { common: { health: "Salud" } } satisfies TranslationMap;

function createManager() {
  const loadTranslation = vi.fn<(locale: Locale) => Promise<TranslationMap | null>>();
  const manager = createI18nManagerForTesting(loadTranslation);
  return {
    internals: manager as unknown as I18nInternals,
    loadTranslation,
    manager,
  };
}

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("repairs a Node-style storage accessor without invoking its unsafe getter", async () => {
    const unsafeGetter = vi.fn(() => {
      throw new Error("Node WebStorage is unavailable without a local-storage file");
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: unsafeGetter,
    });

    const storage = installSafeLocalStorageForTesting();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

    expect(unsafeGetter).not.toHaveBeenCalled();
    expect(Object.hasOwn(descriptor ?? {}, "get")).toBe(false);
    expect(descriptor?.value).toBe(storage);
    expect(getSafeLocalStorage()).toBe(storage);

    const { manager } = createManager();
    await manager.setLocale("en");
    expect(storage.getItem("openclaw.i18n.locale")).toBe("en");
  });

  it("applies and notifies when a failed locale load is retried after recovery", async () => {
    const { internals, loadTranslation, manager } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadTranslation.mockRejectedValueOnce(new Error("gateway unavailable"));
    loadTranslation.mockResolvedValueOnce(german);
    const subscriber = vi.fn();
    const unsubscribe = manager.subscribe(subscriber);

    await manager.setLocale("de");

    expect(manager.getLocale()).toBe("en");
    expect(internals.pendingLocale).toBe("de");
    expect(subscriber).not.toHaveBeenCalled();

    manager.retryPendingLocale();
    await vi.waitFor(() => expect(manager.getLocale()).toBe("de"));

    expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
    expect(internals.pendingLocale).toBeNull();
    unsubscribe();
  });

  it("does nothing when no locale load is pending", () => {
    const { loadTranslation, manager } = createManager();
    const subscriber = vi.fn();
    const unsubscribe = manager.subscribe(subscriber);

    manager.retryPendingLocale();

    expect(loadTranslation).not.toHaveBeenCalled();
    expect(manager.getLocale()).toBe("en");
    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("uses a pre-warmed locale without invoking the loader", async () => {
    const { loadTranslation, manager } = createManager();
    manager.registerTranslation("de", german);

    await manager.setLocale("de");

    expect(manager.getLocale()).toBe("de");
    expect(loadTranslation).not.toHaveBeenCalled();
  });

  it("deduplicates an in-flight target and permits retry after the shared load settles", async () => {
    const { internals, loadTranslation, manager } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const firstLoad = deferred<TranslationMap | null>();
    loadTranslation.mockReturnValueOnce(firstLoad.promise).mockResolvedValueOnce(german);

    const first = manager.setLocale("de");
    const second = manager.setLocale("de");

    expect(loadTranslation).toHaveBeenCalledExactlyOnceWith("de");
    firstLoad.reject(new Error("gateway unavailable"));
    await Promise.all([first, second]);
    expect(internals.pendingLocale).toBe("de");

    manager.retryPendingLocale();
    await vi.waitFor(() => expect(manager.getLocale()).toBe("de"));

    expect(loadTranslation).toHaveBeenCalledTimes(2);
    expect(internals.pendingLocale).toBeNull();
  });

  it("shares one successful in-flight load across same-target callers", async () => {
    const { loadTranslation, manager } = createManager();
    const localeLoad = deferred<TranslationMap | null>();
    const subscriber = vi.fn();
    manager.subscribe(subscriber);
    loadTranslation.mockReturnValueOnce(localeLoad.promise);

    const first = manager.setLocale("de");
    const second = manager.setLocale("de");

    expect(loadTranslation).toHaveBeenCalledExactlyOnceWith("de");
    localeLoad.resolve(german);
    await Promise.all([first, second]);

    expect(manager.getLocale()).toBe("de");
    expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
  });

  it("lets the latest System request clear persistence during a shared load", async () => {
    const { loadTranslation, manager } = createManager();
    vi.stubGlobal("navigator", { language: "de-DE" } as Navigator);
    localStorage.setItem("openclaw.i18n.locale", "es");
    const localeLoad = deferred<TranslationMap | null>();
    loadTranslation.mockReturnValueOnce(localeLoad.promise);

    const explicit = manager.setLocale("de");
    const system = manager.useSystemLocale();

    expect(loadTranslation).toHaveBeenCalledExactlyOnceWith("de");
    localeLoad.resolve(german);
    await Promise.all([explicit, system]);

    expect(manager.getLocale()).toBe("de");
    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
  });

  it("lets the latest explicit request persist during a shared System load", async () => {
    const { loadTranslation, manager } = createManager();
    vi.stubGlobal("navigator", { language: "de-DE" } as Navigator);
    const localeLoad = deferred<TranslationMap | null>();
    loadTranslation.mockReturnValueOnce(localeLoad.promise);

    const system = manager.useSystemLocale();
    const explicit = manager.setLocale("de");

    expect(loadTranslation).toHaveBeenCalledExactlyOnceWith("de");
    localeLoad.resolve(german);
    await Promise.all([system, explicit]);

    expect(manager.getLocale()).toBe("de");
    expect(localStorage.getItem("openclaw.i18n.locale")).toBe("de");
  });

  it("clears an abandoned pending target after another locale succeeds", async () => {
    const { internals, loadTranslation, manager } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadTranslation.mockRejectedValueOnce(new Error("gateway unavailable"));
    loadTranslation.mockResolvedValueOnce(spanish);

    await manager.setLocale("de");
    await manager.setLocale("es");
    manager.retryPendingLocale();

    expect(manager.getLocale()).toBe("es");
    expect(internals.pendingLocale).toBeNull();
    expect(loadTranslation).toHaveBeenCalledTimes(2);
  });

  it("records a repeat failure so a later retry can still recover", async () => {
    const { internals, loadTranslation, manager } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadTranslation
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(new Error("gateway still unavailable"))
      .mockResolvedValueOnce(german);

    await manager.setLocale("de");
    manager.retryPendingLocale();
    await vi.waitFor(() => {
      expect(loadTranslation).toHaveBeenCalledTimes(2);
      expect(internals.pendingLocale).toBe("de");
    });

    manager.retryPendingLocale();
    await vi.waitFor(() => expect(manager.getLocale()).toBe("de"));

    expect(loadTranslation).toHaveBeenCalledTimes(3);
    expect(internals.pendingLocale).toBeNull();
  });

  it("persists and reports a repeated module-import failure while keeping it pending", async () => {
    const { internals, loadTranslation, manager } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const persistedLocalesAtHook: Array<string | null> = [];
    const onUnrecoverableLocaleLoad = vi.fn(() => {
      persistedLocalesAtHook.push(localStorage.getItem("openclaw.i18n.locale"));
    });
    manager.setLocaleLoadRecovery({
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

    await manager.setLocale("fr");
    manager.retryPendingLocale();
    await vi.waitFor(() => expect(loadTranslation).toHaveBeenCalledTimes(2));

    expect(onUnrecoverableLocaleLoad).toHaveBeenCalledExactlyOnceWith("fr");
    expect(persistedLocalesAtHook).toEqual(["fr"]);
    expect(localStorage.getItem("openclaw.i18n.locale")).toBe("fr");
    expect(internals.pendingLocale).toBe("fr");
  });

  it("keeps a pending system locale unpersisted across retry recovery", async () => {
    const { internals, loadTranslation, manager } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("navigator", { language: "de-DE" } as Navigator);
    localStorage.setItem("openclaw.i18n.locale", "es");
    loadTranslation.mockRejectedValueOnce(new Error("gateway unavailable"));
    loadTranslation.mockResolvedValueOnce(german);

    await manager.useSystemLocale();

    expect(manager.getLocale()).toBe("en");
    expect(internals.pendingLocale).toBe("de");
    expect(internals.pendingLocaleShouldPersist).toBe(false);
    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();

    manager.retryPendingLocale();
    await vi.waitFor(() => expect(manager.getLocale()).toBe("de"));

    expect(internals.pendingLocale).toBeNull();
    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
  });

  it("does not persist a system locale for repeated import-failure recovery", async () => {
    const { internals, loadTranslation, manager } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("navigator", { language: "de-DE" } as Navigator);
    localStorage.setItem("openclaw.i18n.locale", "es");
    const onUnrecoverableLocaleLoad = vi.fn();
    manager.setLocaleLoadRecovery({
      isUnrecoverableError: (error) =>
        error instanceof Error &&
        /failed to fetch dynamically imported module/i.test(error.message),
      onUnrecoverableLocaleLoad,
    });
    loadTranslation
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(
        new Error("Failed to fetch dynamically imported module: /assets/de-abc123.js"),
      );

    await manager.useSystemLocale();
    manager.retryPendingLocale();
    await vi.waitFor(() => expect(loadTranslation).toHaveBeenCalledTimes(2));

    expect(onUnrecoverableLocaleLoad).toHaveBeenCalledExactlyOnceWith("de");
    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
    expect(internals.pendingLocale).toBe("de");
    expect(internals.pendingLocaleShouldPersist).toBe(false);
  });

  it("does not report a repeated non-import failure", async () => {
    const { internals, loadTranslation, manager } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onUnrecoverableLocaleLoad = vi.fn();
    manager.setLocaleLoadRecovery({
      isUnrecoverableError: (error) =>
        error instanceof Error &&
        /failed to fetch dynamically imported module/i.test(error.message),
      onUnrecoverableLocaleLoad,
    });
    loadTranslation
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(new Error("request failed"));

    await manager.setLocale("fr");
    manager.retryPendingLocale();
    await vi.waitFor(() => expect(loadTranslation).toHaveBeenCalledTimes(2));

    expect(onUnrecoverableLocaleLoad).not.toHaveBeenCalled();
    expect(internals.pendingLocale).toBe("fr");
  });

  it("ignores an older failure after a newer locale succeeds", async () => {
    const { internals, loadTranslation, manager } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const germanLoad = deferred<TranslationMap | null>();
    const spanishLoad = deferred<TranslationMap | null>();
    loadTranslation
      .mockReturnValueOnce(germanLoad.promise)
      .mockReturnValueOnce(spanishLoad.promise);

    const setGerman = manager.setLocale("de");
    const setSpanish = manager.setLocale("es");
    spanishLoad.resolve(spanish);
    await setSpanish;
    germanLoad.reject(new Error("late German failure"));
    await setGerman;
    manager.retryPendingLocale();

    expect(manager.getLocale()).toBe("es");
    expect(internals.pendingLocale).toBeNull();
    expect(loadTranslation).toHaveBeenCalledTimes(2);
  });

  it("preserves a newer failed target when an older load succeeds late", async () => {
    const { internals, loadTranslation, manager } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const germanLoad = deferred<TranslationMap | null>();
    const spanishLoad = deferred<TranslationMap | null>();
    loadTranslation
      .mockReturnValueOnce(germanLoad.promise)
      .mockReturnValueOnce(spanishLoad.promise)
      .mockResolvedValueOnce(spanish);

    const setGerman = manager.setLocale("de");
    const setSpanish = manager.setLocale("es");
    spanishLoad.reject(new Error("Spanish load failed"));
    await setSpanish;
    germanLoad.resolve(german);
    await setGerman;

    expect(manager.getLocale()).toBe("en");
    expect(internals.pendingLocale).toBe("es");

    manager.retryPendingLocale();
    await vi.waitFor(() => expect(manager.getLocale()).toBe("es"));

    expect(loadTranslation).toHaveBeenCalledTimes(3);
    expect(internals.pendingLocale).toBeNull();
  });
});
