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
import { CLI_ENGLISH_CATALOG, type CliMessageKey } from "./locales/en.js";
import { CLI_ZH_CN_CATALOG } from "./locales/zh-CN.js";

const CLI_SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

const validationIssues = validateCatalog({
  namespace: "cli",
  source: CLI_ENGLISH_CATALOG,
  candidate: CLI_ZH_CN_CATALOG,
});
if (validationIssues.length > 0) {
  throw new Error(`Invalid CLI zh-CN catalog: ${JSON.stringify(validationIssues)}`);
}

const CLI_CATALOG_SNAPSHOT = createCatalogSnapshot({
  catalogRevision: "cli-runtime:1",
  catalogs: {
    en: CLI_ENGLISH_CATALOG,
    "zh-CN": CLI_ZH_CN_CATALOG,
  },
});

export type CliLocalization = {
  context: LocalizationContext;
  t: (key: CliMessageKey, params?: Readonly<Record<string, MessageParam>>) => string;
};

export function createCliLocalization(options?: {
  env?: NodeJS.ProcessEnv;
  locale?: OpenClawLocale;
}): CliLocalization {
  const context = options?.locale
    ? createLocalizationContext({
        locale: options.locale,
        source: "explicit-user",
        audience: "operator",
        supportedLocales: CLI_SUPPORTED_LOCALES,
      })
    : resolveProcessLocalizationContext(options?.env ?? process.env, {
        audience: "operator",
        supportedLocales: CLI_SUPPORTED_LOCALES,
      }).context;

  return Object.freeze({
    context,
    t: (key, params) =>
      renderLocalizedMessage(CLI_CATALOG_SNAPSHOT, context, {
        key,
        params,
        fallback: CLI_ENGLISH_CATALOG[key],
      }),
  });
}
