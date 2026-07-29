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
  // Only the latest selection may update retry state or become active after an async chunk load.
  private localeRequestGeneration = 0;
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

  private resolveInitialLocale(): Locale {
    const saved = this.readStoredLocale();
    if (isSupportedLocale(saved)) {
      return saved;
    }
    const language =
      typeof globalThis.navigator?.language === "string" ? globalThis.navigator.language : null;
    return resolveNavigatorLocale(language ?? "");
  }

  private loadLocale() {
    const initialLocale = this.resolveInitialLocale();
    if (initialLocale === DEFAULT_LOCALE) {
      this.locale = DEFAULT_LOCALE;
      syncDocumentLocale(DEFAULT_LOCALE);
      return;
    }
    // Use the normal locale setter so startup locale loading follows the same
    // translation-loading + notify path as manual locale changes.
    void this.setLocale(initialLocale);
  }

  public getLocale(): Locale {
    return this.locale;
  }

  public async setLocale(locale: Locale) {
    return this.applyLocale(locale, false);
  }

  private async applyLocale(locale: Locale, retrying: boolean) {
    const requestGeneration = ++this.localeRequestGeneration;
    const needsTranslationLoad = locale !== DEFAULT_LOCALE && !this.translations[locale];
    if (this.locale === locale && !needsTranslationLoad) {
      this.pendingLocale = null;
      return;
    }

    if (needsTranslationLoad) {
      this.pendingLocale = locale;
      try {
        const translation = await this.loadLocaleTranslation(locale);
        if (!translation) {
          if (this.localeRequestGeneration === requestGeneration) {
            this.pendingLocale = locale;
          }
          return;
        }
        this.translations[locale] = translation;
      } catch (e) {
        const isCurrentRequest = this.localeRequestGeneration === requestGeneration;
        if (isCurrentRequest) {
          this.pendingLocale = locale;
        }
        if (retrying && isCurrentRequest && this.localeLoadRecovery?.isUnrecoverableError(e)) {
          this.persistLocale(locale);
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
    this.persistLocale(locale);
    this.notify();
  }

  public retryPendingLocale(): void {
    if (this.pendingLocale === null || this.pendingLocale === this.locale) {
      return;
    }
    const target = this.pendingLocale;
    this.pendingLocale = null;
    void this.applyLocale(target, true);
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
      return value.replace(/\{(\w+)\}/g, (_, k) => params[k] || `{${k}}`);
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
