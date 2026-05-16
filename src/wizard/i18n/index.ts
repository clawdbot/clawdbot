import { en } from "./locales/en.js";
import { zh_CN } from "./locales/zh-CN.js";
import { zh_TW } from "./locales/zh-TW.js";
import type {
  WizardI18nParams,
  WizardLocale,
  WizardTranslationMap,
  WizardTranslationTree,
} from "./types.js";

export type { WizardI18nParams, WizardLocale, WizardTranslationMap };

export type SetupTranslator = (key: string, params?: WizardI18nParams) => string;

const LOCALES: Record<WizardLocale, WizardTranslationMap> = {
  en,
  "zh-CN": zh_CN,
  "zh-TW": zh_TW,
};

export const WIZARD_DEFAULT_LOCALE: WizardLocale = "en";
export const WIZARD_SUPPORTED_LOCALES: readonly WizardLocale[] = ["en", "zh-CN", "zh-TW"];

function normalizeLocaleToken(raw: string | undefined): string {
  return (raw ?? "").trim().split(".")[0]?.split("@")[0]?.replaceAll("_", "-") ?? "";
}

export function resolveWizardLocale(value: string | undefined): WizardLocale {
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

export function resolveWizardLocaleFromEnv(env: NodeJS.ProcessEnv = process.env): WizardLocale {
  return resolveWizardLocale(env.OPENCLAW_LOCALE ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG);
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

function collectLeafKeys(tree: WizardTranslationTree, prefix = "", out: string[] = []): string[] {
  for (const [key, value] of Object.entries(tree)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.push(next);
    } else {
      collectLeafKeys(value, next, out);
    }
  }
  return out;
}

export function listWizardI18nKeys(locale: WizardLocale = WIZARD_DEFAULT_LOCALE): string[] {
  return collectLeafKeys(LOCALES[locale]).toSorted();
}
