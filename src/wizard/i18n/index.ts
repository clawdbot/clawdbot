// Wizard i18n helpers resolve translated onboarding copy by locale.
import {
  createCatalogSnapshot,
  createLocalizationContext,
  renderLocalizedMessage,
  resolveProcessLocalizationContext,
  type LocalizationCatalog,
  type LocalizationContext,
  type MessageParam,
} from "@openclaw/localization-core";
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
const WIZARD_LOCALES = ["en", "zh-CN", "zh-TW"] as const;
const WIZARD_CATALOG_SNAPSHOT = createCatalogSnapshot({
  catalogRevision: "wizard:1",
  catalogs: {
    en: flattenTranslationMap(en),
    "zh-CN": flattenTranslationMap(zh_CN),
    "zh-TW": flattenTranslationMap(zh_TW),
  },
});

function resolveWizardContextFromEnv(env: NodeJS.ProcessEnv = process.env): LocalizationContext {
  return resolveProcessLocalizationContext(env, {
    audience: "operator",
    supportedLocales: WIZARD_LOCALES,
  }).context;
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

export function wizardT(
  key: string,
  params?: WizardI18nParams,
  options?: { locale?: WizardLocale },
): string {
  const context = options?.locale
    ? createLocalizationContext({
        locale: options.locale,
        source: "explicit-user",
        audience: "operator",
        supportedLocales: WIZARD_LOCALES,
      })
    : resolveWizardContextFromEnv();
  const messageParams = toMessageParams(params);
  const fallback = readKey(LOCALES[WIZARD_DEFAULT_LOCALE], key) ?? key;
  return renderLocalizedMessage(WIZARD_CATALOG_SNAPSHOT, context, {
    key,
    params: messageParams,
    fallback,
  });
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

function flattenTranslationMap(
  map: WizardTranslationMap,
  prefix = "",
  output: Record<string, string> = {},
): LocalizationCatalog {
  for (const [key, value] of Object.entries(map)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      output[path] = value;
    } else {
      flattenTranslationMap(value, path, output);
    }
  }
  return output;
}

function toMessageParams(
  params: WizardI18nParams | undefined,
): Readonly<Record<string, MessageParam>> | undefined {
  if (!params) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, MessageParam] => entry[1] !== null && entry[1] !== undefined,
    ),
  );
}
