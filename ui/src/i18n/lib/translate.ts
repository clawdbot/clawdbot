// Control UI i18n module implements translate behavior.
import { getSafeLocalStorage } from "../../local-storage.ts";
import { en } from "../locales/en.ts";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  loadLazyLocaleTranslation,
  resolveNavigatorLocale,
} from "./registry.ts";
import type { Locale, TranslationMap } from "./types.ts";

type Subscriber = (locale: Locale) => void;
type LocaleLoadRecovery = {
  isUnrecoverableError: (error: unknown) => boolean;
  onUnrecoverableLocaleLoad?: (locale: Locale) => void;
};
type LocaleTranslationLoader = (locale: Locale) => Promise<TranslationMap | null>;

export { SUPPORTED_LOCALES, isSupportedLocale };

const RTL_LOCALES = new Set<Locale>(["ar", "fa"]);

function syncDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = locale;
  document.documentElement.dir = RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}

class I18nManager {
  private locale: Locale = DEFAULT_LOCALE;
  private translations: Partial<Record<Locale, TranslationMap>> = { [DEFAULT_LOCALE]: en };
  private subscribers: Set<Subscriber> = new Set();
  // Locale chunks are served by the gateway, so a selection made while disconnected can fail.
  // Preserve the target for the next connected transition; otherwise the chrome silently stays
  // in the old language forever.
  private pendingLocale: Locale | null = null;
  private pendingLocaleShouldPersist = true;
  // Only the latest selection may update retry state or become active after an async chunk load.
  private localeRequestGeneration = 0;
  // One chunk import per locale may be active. Settlement removes it so a
  // disconnected/failed load remains retryable on the next connected transition.
  private inFlightLocaleLoads = new Map<Locale, Promise<TranslationMap | null>>();
  private localeLoadRecovery: LocaleLoadRecovery | undefined;

  constructor(
    private readonly loadLocaleTranslation: LocaleTranslationLoader = loadLazyLocaleTranslation,
  ) {
    this.loadLocale();
  }

  private readStoredLocale(): string | null {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return null;
    }
    try {
      return storage.getItem("openclaw.i18n.locale");
    } catch {
      return null;
    }
  }

  private persistLocale(locale: Locale) {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    try {
      storage.setItem("openclaw.i18n.locale", locale);
    } catch {
      // Ignore storage write failures in private/blocked contexts.
    }
  }

  private clearPersistedLocale() {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    try {
      storage.removeItem("openclaw.i18n.locale");
    } catch {
      // Ignore storage write failures in private/blocked contexts.
    }
  }

  private resolveInitialLocale(): { locale: Locale; shouldPersist: boolean } {
    const saved = this.readStoredLocale();
    if (isSupportedLocale(saved)) {
      return { locale: saved, shouldPersist: true };
    }
    const language =
      typeof globalThis.navigator?.language === "string" ? globalThis.navigator.language : null;
    return { locale: resolveNavigatorLocale(language ?? ""), shouldPersist: false };
  }

  private loadLocale() {
    const initial = this.resolveInitialLocale();
    if (initial.locale === DEFAULT_LOCALE) {
      this.locale = DEFAULT_LOCALE;
      syncDocumentLocale(DEFAULT_LOCALE);
      if (!initial.shouldPersist) {
        this.clearPersistedLocale();
      }
      return;
    }
    // Use the normal locale setter so startup locale loading follows the same
    // translation-loading + notify path as manual locale changes.
    void this.applyLocale(initial.locale, false, initial.shouldPersist);
  }

  public getLocale(): Locale {
    return this.locale;
  }

  public getSystemLocale(): Locale {
    const language =
      typeof globalThis.navigator?.language === "string" ? globalThis.navigator.language : null;
    return resolveNavigatorLocale(language ?? "");
  }

  public async setLocale(locale: Locale) {
    return this.applyLocale(locale, false, true);
  }

  public async useSystemLocale() {
    return this.applyLocale(this.getSystemLocale(), false, false);
  }

  private loadLocaleTranslationOnce(locale: Locale): Promise<TranslationMap | null> {
    const existing = this.inFlightLocaleLoads.get(locale);
    if (existing) {
      return existing;
    }
    const load = this.loadLocaleTranslation(locale);
    const clearSettledLoad = () => {
      if (this.inFlightLocaleLoads.get(locale) === load) {
        this.inFlightLocaleLoads.delete(locale);
      }
    };
    this.inFlightLocaleLoads.set(locale, load);
    void load.then(clearSettledLoad, clearSettledLoad);
    return load;
  }

  private async applyLocale(locale: Locale, retrying: boolean, shouldPersist: boolean) {
    const requestGeneration = ++this.localeRequestGeneration;
    const needsTranslationLoad = locale !== DEFAULT_LOCALE && !this.translations[locale];
    if (!shouldPersist) {
      // System mode is an unset preference. Clear it before any async chunk
      // load so a failed load cannot resurrect the previous explicit locale.
      this.clearPersistedLocale();
    }
    if (this.locale === locale && !needsTranslationLoad) {
      this.pendingLocale = null;
      if (shouldPersist) {
        this.persistLocale(locale);
      }
      return;
    }

    if (needsTranslationLoad) {
      this.pendingLocale = locale;
      this.pendingLocaleShouldPersist = shouldPersist;
      try {
        const translation = await this.loadLocaleTranslationOnce(locale);
        if (!translation) {
          if (this.localeRequestGeneration === requestGeneration) {
            this.pendingLocale = locale;
            this.pendingLocaleShouldPersist = shouldPersist;
          }
          return;
        }
        this.translations[locale] = translation;
      } catch (e) {
        const isCurrentRequest = this.localeRequestGeneration === requestGeneration;
        if (isCurrentRequest) {
          this.pendingLocale = locale;
          this.pendingLocaleShouldPersist = shouldPersist;
        }
        if (retrying && isCurrentRequest && this.localeLoadRecovery?.isUnrecoverableError(e)) {
          if (shouldPersist) {
            this.persistLocale(locale);
          }
          this.localeLoadRecovery.onUnrecoverableLocaleLoad?.(locale);
        }
        console.error(`Failed to load locale: ${locale}`, e);
        return;
      }
    }

    if (this.localeRequestGeneration !== requestGeneration) {
      return;
    }
    this.pendingLocale = null;
    this.locale = locale;
    syncDocumentLocale(locale);
    if (shouldPersist) {
      this.persistLocale(locale);
    }
    this.notify();
  }

  public retryPendingLocale(): void {
    if (this.pendingLocale === null || this.pendingLocale === this.locale) {
      return;
    }
    const target = this.pendingLocale;
    const shouldPersist = this.pendingLocaleShouldPersist;
    this.pendingLocale = null;
    void this.applyLocale(target, true, shouldPersist);
  }

  public setLocaleLoadRecovery(recovery: LocaleLoadRecovery | undefined): void {
    // Keep this leaf independent of app-level stale-chunk policy; the app injects both the
    // error classifier and guarded recovery action.
    this.localeLoadRecovery = recovery;
  }

  public registerTranslation(locale: Locale, map: TranslationMap) {
    this.translations[locale] = map;
  }

  public subscribe(sub: Subscriber) {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private notify() {
    this.subscribers.forEach((sub) => sub(this.locale));
  }

  public t(key: string, params?: Record<string, string>): string {
    const keys = key.split(".");
    let value: unknown = this.translations[this.locale] || this.translations[DEFAULT_LOCALE];

    for (const k of keys) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[k];
      } else {
        value = undefined;
        break;
      }
    }

    // Fallback to English.
    if (value === undefined && this.locale !== DEFAULT_LOCALE) {
      value = this.translations[DEFAULT_LOCALE];
      for (const k of keys) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[k];
        } else {
          value = undefined;
          break;
        }
      }
    }

    if (typeof value !== "string") {
      return key;
    }

    if (params) {
      // ?? not ||: an empty-string param is a provided value (render empty),
      // while a missing param keeps the visible {placeholder} for debugging.
      return value.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
    }

    return value;
  }
}

export const i18n = new I18nManager();
export const t = (key: string, params?: Record<string, string>) => i18n.t(key, params);

if (typeof process !== "undefined" && (process.env?.VITEST || process.env?.NODE_ENV === "test")) {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.i18nManagerTestApi")] = {
    createI18nManager(loadLocaleTranslation: LocaleTranslationLoader) {
      return new I18nManager(loadLocaleTranslation);
    },
  };
}
