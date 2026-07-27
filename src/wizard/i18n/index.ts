// Wizard i18n helpers resolve translated onboarding copy by locale.
import { en } from "./locales/en.js";
import { zh_CN } from "./locales/zh-CN.js";
import { zh_TW } from "./locales/zh-TW.js";
import type {
  WizardI18nParams,
  WizardLocale,
  WizardTranslationMap,
  WizardTranslationTree,
} from "./types.js";

export type { WizardI18nParams };

// Wizard i18n uses dotted keys with English fallback. Locale selection is
// intentionally small because setup copy is maintained in-tree.
export type SetupTranslator = (key: string, params?: WizardI18nParams) => string;

const LOCALES: Record<WizardLocale, WizardTranslationMap> = {
  en,
  "zh-CN": zh_CN,
  "zh-TW": zh_TW,
};

const WIZARD_DEFAULT_LOCALE: WizardLocale = "en";

function normalizeLocaleToken(raw: string | undefined): string {
  return (raw ?? "").trim().split(".")[0]?.split("@")[0]?.replaceAll("_", "-") ?? "";
}

// Resolve shell/browser locale strings such as zh_Hant_TW.UTF-8 into supported
// setup locales, falling back to English for unknown languages.
function resolveWizardLocale(value: string | undefined): WizardLocale {
  const normalized = normalizeLocaleToken(value);
  if (!normalized) {
    return WIZARD_DEFAULT_LOCALE;
  }

  const lower = normalized.toLowerCase();
  if (lower === "en" || lower.startsWith("en-")) {
    return "en";
  }
  if (lower === "zh-tw" || lower === "zh-hk" || lower === "zh-mo" || lower.includes("hant")) {
    return "zh-TW";
  }
  if (lower === "zh" || lower === "zh-cn" || lower === "zh-sg" || lower.includes("hans")) {
    return "zh-CN";
  }
  return WIZARD_DEFAULT_LOCALE;
}

function resolveWizardLocaleFromEnv(env: NodeJS.ProcessEnv = process.env): WizardLocale {
  const locale = [env.OPENCLAW_LOCALE, env.LC_ALL, env.LC_MESSAGES, env.LANG].find((value) =>
    value?.trim(),
  );
  return resolveWizardLocale(locale);
}

function readKey(map: WizardTranslationMap, key: string): string | undefined {
  let value: string | WizardTranslationTree | undefined = map;
  for (const segment of key.split(".")) {
    if (!value || typeof value === "string") {
      return undefined;
    }
    value = value[segment];
  }
  return typeof value === "string" ? value : undefined;
}

function interpolate(value: string, params?: WizardI18nParams): string {
  if (!params) {
    return value;
  }
  return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    const param = params[key];
    return param === undefined || param === null ? match : String(param);
  });
}

export function wizardT(
  key: string,
  params?: WizardI18nParams,
  options?: { locale?: WizardLocale },
): string {
  const locale = options?.locale ?? resolveWizardLocaleFromEnv();
  const localized = readKey(LOCALES[locale], key);
  const fallback = localized ?? readKey(LOCALES[WIZARD_DEFAULT_LOCALE], key) ?? key;
  return interpolate(fallback, params);
}

export const t = wizardT;

// Prefix-aware translator for setup subflows. Common and wizard keys remain
// absolute so shared copy can be reused from any subflow.
export function createSetupTranslator(options?: {
  locale?: WizardLocale;
  keyPrefix?: string;
}): SetupTranslator {
  const normalizedPrefix = options?.keyPrefix?.replace(/\.$/, "");
  return (key, params) => {
    const resolvedKey =
      normalizedPrefix && !key.startsWith("common.") && !key.startsWith("wizard.")
        ? `${normalizedPrefix}.${key}`
        : key;
    return wizardT(resolvedKey, params, { locale: options?.locale });
  };
}
