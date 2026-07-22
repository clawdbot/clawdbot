import {
  createCatalogSnapshot,
  createLocalizationContext,
  renderLocalizedMessage,
  resolveProcessLocalizationContext,
  validateCatalog,
  type LocalizationContext,
  type MessageParam,
  type OpenClawLocale,
} from "@openclaw/localization-core";
import { TUI_ENGLISH_CATALOG, type TuiMessageKey } from "./locales/en.js";
import { TUI_ZH_CN_CATALOG } from "./locales/zh-CN.js";

export const TUI_SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

const validationIssues = validateCatalog({
  namespace: "tui",
  source: TUI_ENGLISH_CATALOG,
  candidate: TUI_ZH_CN_CATALOG,
});
if (validationIssues.length > 0) {
  throw new Error(`Invalid TUI zh-CN catalog: ${JSON.stringify(validationIssues)}`);
}

const TUI_CATALOG_SNAPSHOT = createCatalogSnapshot({
  catalogRevision: "tui-status:1",
  catalogs: {
    en: TUI_ENGLISH_CATALOG,
    "zh-CN": TUI_ZH_CN_CATALOG,
  },
});

export type TuiLocalization = {
  context: LocalizationContext;
  t: (key: TuiMessageKey, params?: Readonly<Record<string, MessageParam>>) => string;
};

export function createTuiLocalization(options?: {
  env?: NodeJS.ProcessEnv;
  locale?: OpenClawLocale;
}): TuiLocalization {
  const context = options?.locale
    ? createLocalizationContext({
        locale: options.locale,
        source: "explicit-user",
        audience: "operator",
        supportedLocales: TUI_SUPPORTED_LOCALES,
      })
    : resolveProcessLocalizationContext(options?.env ?? process.env, {
        audience: "operator",
        supportedLocales: TUI_SUPPORTED_LOCALES,
      }).context;

  return Object.freeze({
    context,
    t: (key, params) =>
      renderLocalizedMessage(TUI_CATALOG_SNAPSHOT, context, {
        key,
        params,
        fallback: TUI_ENGLISH_CATALOG[key],
      }),
  });
}
